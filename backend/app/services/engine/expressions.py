"""Langage des colonnes et mesures calculées → SQL DuckDB.

Aucune expression n'est transmise telle quelle à DuckDB : elle est analysée (lexer + parseur
récursif), typée, puis recompilée en SQL par ce module. Les noms de colonnes passent par
`quote_ident`, les nombres et textes sont réécrits à partir de leur valeur analysée.

Syntaxe (inspirée d'Excel / DAX, fonctions en anglais ou en français) :

    marge          = SUM(chiffre_affaires) - SUM(cout)
    taux de marge  = DIVIDE([marge], SUM(chiffre_affaires))
    panier moyen   = SOMME(chiffre_affaires) / NB(*)
    prix TTC       = prix_unitaire * 1.2                        (colonne calculée)
    grosse vente   = SI(chiffre_affaires > 1000, "Oui", "Non")   (colonne calculée)

- Noms : `chiffre_affaires` ou `[chiffre d'affaires]` (crochets pour les espaces).
- Nombres avec un point décimal (1.2) ; textes entre guillemets ("…" ou '…').
- Opérateurs : + - * / ( ), comparaisons = <> != < <= > >=, ET / AND, OU / OR, NON / NOT.
- La division par zéro donne une valeur vide (jamais une erreur ni l'infini).
"""

import difflib
import re
from dataclasses import dataclass, field
from typing import Literal

from app.schemas.dataset import ColumnType
from app.services.engine.database import quote_ident

Kind = Literal["column", "measure"]
ExprType = Literal["number", "string", "boolean", "date", "null"]

MAX_LENGTH = 2000
MAX_DEPTH = 8


class ExpressionError(ValueError):
    """Expression invalide ; `position` = index du caractère fautif (pour l'éditeur)."""

    def __init__(self, message: str, position: int | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.position = position


# ─── Analyse lexicale ────────────────────────────────────────────────────────────────

TOKEN = re.compile(
    r"""
    (?P<ws>\s+)
  | (?P<number>\d+(?:\.\d+)?)
  | (?P<string>"(?:[^"]|"")*"|'(?:[^']|'')*')
  | (?P<bracket>\[[^\]]+\])
  | (?P<name>[^\W\d][\w]*)
  | (?P<op><=|>=|<>|!=|[-+*/(),<>=])
    """,
    re.VERBOSE | re.UNICODE,
)


@dataclass(frozen=True)
class Token:
    kind: str
    value: str
    pos: int


def tokenize(text: str) -> list[Token]:
    if len(text) > MAX_LENGTH:
        raise ExpressionError(f"Expression trop longue ({MAX_LENGTH} caractères au plus).")
    tokens: list[Token] = []
    pos = 0
    while pos < len(text):
        m = TOKEN.match(text, pos)
        if not m:
            raise ExpressionError(f"Caractère inattendu « {text[pos]} ».", pos)
        kind = m.lastgroup or ""
        if kind != "ws":
            raw = m.group(0)
            if kind == "string":
                raw = raw[1:-1].replace(raw[0] * 2, raw[0])
            elif kind == "bracket":
                raw = raw[1:-1].strip()
            tokens.append(Token(kind, raw, pos))
        pos = m.end()
    tokens.append(Token("end", "", len(text)))
    return tokens


# ─── Arbre ───────────────────────────────────────────────────────────────────────────


@dataclass
class Node:
    pos: int


@dataclass
class Num(Node):
    value: float


@dataclass
class Str(Node):
    value: str


@dataclass
class Bool(Node):
    value: bool


@dataclass
class Ref(Node):
    name: str


@dataclass
class Star(Node):
    pass


@dataclass
class Unary(Node):
    op: str
    operand: Node


@dataclass
class Binary(Node):
    op: str
    left: Node
    right: Node


@dataclass
class Call(Node):
    name: str
    args: list[Node] = field(default_factory=list)


KEYWORDS = {"AND": "AND", "ET": "AND", "OR": "OR", "OU": "OR", "NOT": "NOT", "NON": "NOT"}
CONSTANTS = {"TRUE": True, "VRAI": True, "FALSE": False, "FAUX": False}


class Parser:
    def __init__(self, text: str) -> None:
        self.tokens = tokenize(text)
        self.i = 0

    @property
    def tok(self) -> Token:
        return self.tokens[self.i]

    def keyword(self) -> str | None:
        return KEYWORDS.get(self.tok.value.upper()) if self.tok.kind == "name" else None

    def take(self, value: str) -> bool:
        if self.tok.kind == "op" and self.tok.value == value:
            self.i += 1
            return True
        return False

    def expect(self, value: str) -> None:
        if not self.take(value):
            found = self.tok.value or "la fin de l'expression"
            raise ExpressionError(f"« {value} » attendu, « {found} » trouvé.", self.tok.pos)

    def parse(self) -> Node:
        if self.tok.kind == "end":
            raise ExpressionError("Expression vide.", 0)
        node = self.or_()
        if self.tok.kind != "end":
            raise ExpressionError(f"« {self.tok.value} » inattendu.", self.tok.pos)
        return node

    def or_(self) -> Node:
        node = self.and_()
        while self.keyword() == "OR":
            pos = self.tok.pos
            self.i += 1
            node = Binary(pos, "OR", node, self.and_())
        return node

    def and_(self) -> Node:
        node = self.not_()
        while self.keyword() == "AND":
            pos = self.tok.pos
            self.i += 1
            node = Binary(pos, "AND", node, self.not_())
        return node

    def not_(self) -> Node:
        if self.keyword() == "NOT":
            pos = self.tok.pos
            self.i += 1
            return Unary(pos, "NOT", self.not_())
        return self.comparison()

    def comparison(self) -> Node:
        node = self.additive()
        if self.tok.kind == "op" and self.tok.value in {"=", "<>", "!=", "<", "<=", ">", ">="}:
            tok = self.tok
            self.i += 1
            node = Binary(tok.pos, "<>" if tok.value == "!=" else tok.value, node, self.additive())
        return node

    def additive(self) -> Node:
        node = self.term()
        while self.tok.kind == "op" and self.tok.value in {"+", "-"}:
            tok = self.tok
            self.i += 1
            node = Binary(tok.pos, tok.value, node, self.term())
        return node

    def term(self) -> Node:
        node = self.unary()
        while self.tok.kind == "op" and self.tok.value in {"*", "/"}:
            tok = self.tok
            self.i += 1
            node = Binary(tok.pos, tok.value, node, self.unary())
        return node

    def unary(self) -> Node:
        if self.tok.kind == "op" and self.tok.value in {"-", "+"}:
            tok = self.tok
            self.i += 1
            operand = self.unary()
            return operand if tok.value == "+" else Unary(tok.pos, "-", operand)
        return self.primary()

    def primary(self) -> Node:
        tok = self.tok
        if tok.kind == "number":
            self.i += 1
            return Num(tok.pos, float(tok.value))
        if tok.kind == "string":
            self.i += 1
            return Str(tok.pos, tok.value)
        if tok.kind == "bracket":
            self.i += 1
            return Ref(tok.pos, tok.value)
        if tok.kind == "name":
            self.i += 1
            if tok.value.upper() in CONSTANTS and not (self.tok.kind == "op" and self.tok.value == "("):
                return Bool(tok.pos, CONSTANTS[tok.value.upper()])
            if self.take("("):
                args: list[Node] = []
                # Syntaxe SQL « COUNT(DISTINCT x) » acceptée comme COUNT_DISTINCT(x).
                if (
                    tok.value.upper() in {"COUNT", "NB"}
                    and self.tok.kind == "name"
                    and self.tok.value.upper() == "DISTINCT"
                ):
                    self.i += 1
                    tok = Token(tok.kind, "COUNT_DISTINCT", tok.pos)
                if not self.take(")"):
                    while True:
                        if self.tok.kind == "op" and self.tok.value == "*":
                            args.append(Star(self.tok.pos))
                            self.i += 1
                        else:
                            args.append(self.or_())
                        if self.take(")"):
                            break
                        self.expect(",")
                return Call(tok.pos, tok.value, args)
            return Ref(tok.pos, tok.value)
        if self.take("("):
            node = self.or_()
            self.expect(")")
            return node
        found = tok.value or "la fin de l'expression"
        raise ExpressionError(f"Valeur attendue, « {found} » trouvé.", tok.pos)


# ─── Compilation typée ───────────────────────────────────────────────────────────────

AGGREGATES = {
    "SUM": "SUM",
    "SOMME": "SUM",
    "AVG": "AVG",
    "AVERAGE": "AVG",
    "MOYENNE": "AVG",
    "MEDIAN": "MEDIAN",
    "MEDIANE": "MEDIAN",
    "MÉDIANE": "MEDIAN",
    "MIN": "MIN",
    "MAX": "MAX",
    "COUNT": "COUNT",
    "NB": "COUNT",
    "COUNT_DISTINCT": "COUNT_DISTINCT",
    "DISTINCTCOUNT": "COUNT_DISTINCT",
    "NB_DISTINCT": "COUNT_DISTINCT",
}
SCALARS = {
    "ABS": "ABS",
    "ROUND": "ROUND",
    "ARRONDI": "ROUND",
    "DIVIDE": "DIVIDE",
    "DIVISER": "DIVIDE",
    "IF": "IF",
    "SI": "IF",
    "COALESCE": "COALESCE",
    "SIVIDE": "COALESCE",
    "YEAR": "YEAR",
    "ANNEE": "YEAR",
    "ANNÉE": "YEAR",
    "MONTH": "MONTH",
    "MOIS": "MONTH",
    "CONCAT": "CONCAT",
    "CONCATENER": "CONCAT",
}
#: Fonctions proposées par l'éditeur (nom affiché, syntaxe, contexte).
CATALOG = [
    ("SUM", "SUM(colonne)", "measure"),
    ("AVG", "AVG(colonne)", "measure"),
    ("MEDIAN", "MEDIAN(colonne)", "measure"),
    ("MIN", "MIN(colonne)", "measure"),
    ("MAX", "MAX(colonne)", "measure"),
    ("COUNT", "COUNT(*) ou COUNT(colonne)", "measure"),
    ("COUNT_DISTINCT", "COUNT_DISTINCT(colonne)", "measure"),
    ("DIVIDE", "DIVIDE(a, b[, si_zéro])", "both"),
    ("IF", "IF(condition, si_vrai, si_faux)", "both"),
    ("ROUND", "ROUND(x[, décimales])", "both"),
    ("ABS", "ABS(x)", "both"),
    ("COALESCE", "COALESCE(x, valeur_si_vide)", "both"),
    ("YEAR", "YEAR(date)", "column"),
    ("MONTH", "MONTH(date)", "column"),
    ("CONCAT", "CONCAT(a, b, …)", "column"),
]

TYPE_LABEL = {
    "number": "un nombre",
    "string": "un texte",
    "boolean": "un booléen",
    "date": "une date",
    "null": "une valeur vide",
}


@dataclass(frozen=True)
class Compiled:
    sql: str
    type: ExprType


@dataclass
class Scope:
    """Ce qu'une expression peut référencer.

    - `columns` : colonnes de base et calculées (nom → (SQL, type)) ;
    - `measures` : expressions des mesures calculées (nom → texte), développées à l'usage.
    """

    columns: dict[str, tuple[str, ColumnType]]
    measures: dict[str, str] = field(default_factory=dict)


def _suggest(name: str, choices: list[str]) -> str:
    close = difflib.get_close_matches(name, choices, n=1, cutoff=0.6)
    return f" Vouliez-vous dire « {close[0]} » ?" if close else ""


class Compiler:
    def __init__(self, scope: Scope, kind: Kind, stack: tuple[str, ...] = ()) -> None:
        self.scope = scope
        self.kind = kind
        self.stack = stack
        self.in_aggregate = False

    def compile(self, node: Node) -> Compiled:
        match node:
            case Num(value=v):
                text = str(int(v)) if v.is_integer() and abs(v) < 1e15 else repr(v)
                return Compiled(text, "number")
            case Str(value=v):
                return Compiled("'" + v.replace("'", "''") + "'", "string")
            case Bool(value=v):
                return Compiled("TRUE" if v else "FALSE", "boolean")
            case Star():
                raise ExpressionError("« * » ne s'utilise que dans COUNT(*).", node.pos)
            case Ref():
                return self.ref(node)
            case Unary(op="-", operand=o):
                c = self.number(o, "« - »")
                return Compiled(f"(-{c.sql})", "number")
            case Unary(op="NOT", operand=o):
                c = self.compile(o)
                self.want(c, "boolean", o, "NON")
                return Compiled(f"(NOT {c.sql})", "boolean")
            case Binary():
                return self.binary(node)
            case Call():
                return self.call(node)
        raise ExpressionError("Expression non reconnue.", node.pos)

    def want(self, c: Compiled, expected: ExprType, node: Node, where: str) -> None:
        if c.type not in {expected, "null"}:
            raise ExpressionError(f"{where} attend {TYPE_LABEL[expected]}, pas {TYPE_LABEL[c.type]}.", node.pos)

    def number(self, node: Node, where: str) -> Compiled:
        c = self.compile(node)
        if c.type == "boolean":
            return Compiled(f"CAST({c.sql} AS INTEGER)", "number")
        self.want(c, "number", node, where)
        return c

    def ref(self, node: Ref) -> Compiled:
        name = node.name
        if name in self.scope.columns:
            if self.kind == "measure" and not self.in_aggregate:
                raise ExpressionError(
                    f"Dans une mesure, « {name} » doit être agrégé : SUM({name}), AVG({name}), COUNT({name})…",
                    node.pos,
                )
            sql, kind = self.scope.columns[name]
            return Compiled(sql, kind)
        if name in self.scope.measures:
            if self.kind == "column":
                raise ExpressionError(
                    f"« {name} » est une mesure : une colonne calculée ne peut pas l'utiliser.", node.pos
                )
            if self.in_aggregate:
                raise ExpressionError(
                    f"« {name} » est déjà une mesure agrégée : ne l'entourez pas de SUM / AVG.", node.pos
                )
            if name in self.stack or len(self.stack) >= MAX_DEPTH:
                raise ExpressionError(f"Référence circulaire : {' → '.join([*self.stack, name])}.", node.pos)
            try:
                tree = Parser(self.scope.measures[name]).parse()
                inner = Compiler(self.scope, "measure", (*self.stack, name)).compile(tree)
            except ExpressionError as exc:
                if exc.message.startswith(("Référence circulaire", "La mesure")):
                    raise ExpressionError(exc.message, node.pos) from exc
                raise ExpressionError(f"La mesure « {name} » est invalide : {exc.message}", node.pos) from exc
            return Compiled(f"({inner.sql})", inner.type)
        known = list(self.scope.columns) + list(self.scope.measures)
        raise ExpressionError(f"Champ ou mesure inconnu : « {name} ».{_suggest(name, known)}", node.pos)

    def binary(self, node: Binary) -> Compiled:
        op = node.op
        if op in {"AND", "OR"}:
            left, right = self.compile(node.left), self.compile(node.right)
            word = "ET" if op == "AND" else "OU"
            self.want(left, "boolean", node.left, word)
            self.want(right, "boolean", node.right, word)
            return Compiled(f"({left.sql} {op} {right.sql})", "boolean")
        if op in {"+", "-", "*", "/"}:
            left, right = self.number(node.left, f"« {op} »"), self.number(node.right, f"« {op} »")
            if op == "/":
                return Compiled(f"({left.sql} / NULLIF({right.sql}, 0))", "number")
            return Compiled(f"({left.sql} {op} {right.sql})", "number")
        left, right = self.compile(node.left), self.compile(node.right)
        pair = {left.type, right.type}
        compatible = (
            left.type == right.type or "null" in pair or pair <= {"number", "boolean"} or pair == {"date", "string"}
        )
        if not compatible:
            raise ExpressionError(
                f"Comparaison impossible entre {TYPE_LABEL[left.type]} et {TYPE_LABEL[right.type]}.", node.pos
            )
        # Date comparée à un texte (« date >= '2026-03-01' ») : le texte est converti en date.
        lsql = f"CAST({left.sql} AS TIMESTAMP)" if pair == {"date", "string"} and left.type == "string" else left.sql
        rsql = f"CAST({right.sql} AS TIMESTAMP)" if pair == {"date", "string"} and right.type == "string" else right.sql
        return Compiled(f"({lsql} {op} {rsql})", "boolean")

    def arity(self, node: Call, low: int, high: int) -> None:
        n = len(node.args)
        if not low <= n <= high:
            expected = str(low) if low == high else f"{low} à {high}"
            raise ExpressionError(f"{node.name.upper()} attend {expected} argument(s), {n} donné(s).", node.pos)

    def call(self, node: Call) -> Compiled:
        upper = node.name.upper()
        if upper in AGGREGATES:
            return self.aggregate(node, AGGREGATES[upper])
        fn = SCALARS.get(upper)
        if fn is None:
            names = sorted(set(AGGREGATES) | set(SCALARS))
            raise ExpressionError(f"Fonction inconnue « {node.name} ».{_suggest(upper, names)}", node.pos)
        if fn == "ABS":
            self.arity(node, 1, 1)
            return Compiled(f"ABS({self.number(node.args[0], 'ABS').sql})", "number")
        if fn == "ROUND":
            self.arity(node, 1, 2)
            x = self.number(node.args[0], "ROUND")
            digits = 0
            if len(node.args) == 2:
                d = node.args[1]
                if not isinstance(d, Num) or not d.value.is_integer() or not 0 <= d.value <= 10:
                    raise ExpressionError("ROUND : le nombre de décimales doit être un entier de 0 à 10.", d.pos)
                digits = int(d.value)
            return Compiled(f"ROUND({x.sql}, {digits})", "number")
        if fn == "DIVIDE":
            self.arity(node, 2, 3)
            a, b = self.number(node.args[0], "DIVIDE"), self.number(node.args[1], "DIVIDE")
            sql = f"({a.sql} / NULLIF({b.sql}, 0))"
            if len(node.args) == 3:
                sql = f"COALESCE({sql}, {self.number(node.args[2], 'DIVIDE').sql})"
            return Compiled(sql, "number")
        if fn == "IF":
            self.arity(node, 2, 3)
            cond = self.compile(node.args[0])
            self.want(cond, "boolean", node.args[0], "La condition de IF")
            yes = self.compile(node.args[1])
            no = self.compile(node.args[2]) if len(node.args) == 3 else Compiled("NULL", "null")
            kind = yes.type if yes.type != "null" else no.type
            if "null" not in {yes.type, no.type} and yes.type != no.type:
                raise ExpressionError(
                    "IF : les deux résultats doivent être du même type "
                    f"({TYPE_LABEL[yes.type]}, {TYPE_LABEL[no.type]}).",
                    node.pos,
                )
            return Compiled(
                f"(CASE WHEN {cond.sql} THEN {yes.sql} ELSE {no.sql} END)", kind if kind != "null" else "number"
            )
        if fn == "COALESCE":
            self.arity(node, 2, 2)
            a, b = self.compile(node.args[0]), self.compile(node.args[1])
            if "null" not in {a.type, b.type} and a.type != b.type:
                raise ExpressionError("COALESCE : les deux valeurs doivent être du même type.", node.pos)
            return Compiled(f"COALESCE({a.sql}, {b.sql})", a.type if a.type != "null" else b.type)
        if fn in {"YEAR", "MONTH"}:
            self.arity(node, 1, 1)
            d = self.compile(node.args[0])
            self.want(d, "date", node.args[0], fn)
            return Compiled(f"{fn}({d.sql})", "number")
        # CONCAT
        if len(node.args) < 2:
            raise ExpressionError("CONCAT attend au moins 2 arguments.", node.pos)
        parts = [f"CAST({self.compile(a).sql} AS VARCHAR)" for a in node.args]
        return Compiled(f"CONCAT({', '.join(parts)})", "string")

    def aggregate(self, node: Call, fn: str) -> Compiled:
        if self.kind == "column":
            raise ExpressionError(
                f"{node.name.upper()} est une agrégation : utilisez une mesure calculée, pas une colonne.", node.pos
            )
        if self.in_aggregate:
            raise ExpressionError("Une agrégation ne peut pas en contenir une autre.", node.pos)
        self.arity(node, 1, 1)
        arg = node.args[0]
        if isinstance(arg, Star):
            if fn != "COUNT":
                raise ExpressionError("« * » ne s'utilise que dans COUNT(*).", arg.pos)
            return Compiled("COUNT(*)", "number")
        self.in_aggregate = True
        try:
            inner = self.compile(arg)
        finally:
            self.in_aggregate = False
        if fn in {"SUM", "AVG", "MEDIAN"}:
            if inner.type == "boolean":
                return Compiled(f"{fn}(CAST({inner.sql} AS INTEGER))", "number")
            self.want(inner, "number", arg, fn)
        if fn == "COUNT_DISTINCT":
            return Compiled(f"COUNT(DISTINCT {inner.sql})", "number")
        kind: ExprType = inner.type if fn in {"MIN", "MAX"} else "number"
        return Compiled(f"{fn}({inner.sql})", kind)


def compile_expression(text: str, kind: Kind, scope: Scope, name: str | None = None) -> Compiled:
    """Analyse et compile une expression ; lève `ExpressionError` (message en français, position)."""
    tree = Parser(text).parse()
    stack = (name,) if name and kind == "measure" else ()
    result = Compiler(scope, kind, stack).compile(tree)
    if kind == "measure" and result.type not in {"number", "null"}:
        raise ExpressionError(f"Une mesure doit produire un nombre (ici : {TYPE_LABEL[result.type]}).", 0)
    if result.type == "null":
        raise ExpressionError("L'expression ne produit que des valeurs vides.", 0)
    return result


def column_scope(types: dict[str, ColumnType]) -> dict[str, tuple[str, ColumnType]]:
    """Colonnes de base, référencées par leur nom SQL."""
    return {name: (quote_ident(name), kind) for name, kind in types.items()}
