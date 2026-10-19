import { Fragment, type ReactNode } from "react";

/**
 * Rendu minimal du Markdown renvoyé par les LLM : **gras**, `code`, puces « - ».
 * Volontairement sans HTML brut (pas de dangerouslySetInnerHTML) : aucun risque d'injection.
 */
export function RichText({ text }: { text: string }) {
  return (
    <>
      {text.split("\n").map((line, i) => {
        const bullet = /^\s*[-*•]\s+/.exec(line);
        const content = inline(bullet ? line.slice(bullet[0].length) : line);
        return bullet ? (
          <span key={i} className="flex gap-1.5">
            <span aria-hidden>•</span>
            <span>{content}</span>
          </span>
        ) : (
          <Fragment key={i}>
            {content}
            {"\n"}
          </Fragment>
        );
      })}
    </>
  );
}

function inline(line: string): ReactNode[] {
  return line.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("`") && part.endsWith("`"))
      return (
        <code key={i} className="rounded bg-bg px-1 font-mono text-[0.85em]">
          {part.slice(1, -1)}
        </code>
      );
    return part;
  });
}
