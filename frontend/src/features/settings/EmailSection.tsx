import { Loader2, Mail, ShieldCheck } from "lucide-react";
import { useEffect, useId, useState } from "react";

import { usePreferences } from "../../hooks/usePreferences";
import { api } from "../../lib/api";
import type { EmailConfig, EmailState, SmtpSecurity } from "../../types/email";
import { invalidRecipient, parseRecipients } from "../automation/alerts";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const input = "rounded-md border border-border bg-field px-2 py-1.5 text-xs text-fg";
const EMPTY: EmailConfig = { host: "", port: 587, security: "starttls", username: "", from_addr: "" };
const PORTS: Record<SmtpSecurity, number> = { starttls: 587, ssl: 465, none: 25 };

/** Erreur de saisie du serveur d'envoi, ou null. */
export function emailConfigError(c: EmailConfig): string | null {
  if (!c.host.trim()) return "Indiquez le serveur d'envoi (ex. smtp.entreprise.fr).";
  if (!/^[A-Za-z0-9.\-:[\]]+$/.test(c.host.trim())) return "Nom de serveur invalide.";
  if (!Number.isInteger(c.port) || c.port < 1 || c.port > 65535) return "Port invalide (1 à 65 535).";
  if (invalidRecipient([c.from_addr.trim()]) !== null) return "Adresse d'expéditeur invalide.";
  return null;
}

/**
 * Réglages → E-mail des alertes : serveur SMTP de l'utilisateur, mot de passe au trousseau, essai.
 * Hors ligne, seul un serveur de la machine ou du réseau de l'entreprise est joint.
 */
export function EmailSection() {
  const id = useId();
  const { prefs } = usePreferences();
  const [state, setState] = useState<EmailState | null>(null);
  const [form, setForm] = useState<EmailConfig>(EMPTY);
  const [password, setPassword] = useState("");
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState<"save" | "test" | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    api.email.state().then(
      (s) => {
        setState(s);
        if (s.config) setForm({ ...EMPTY, ...s.config, username: s.config.username ?? "" });
      },
      (e: unknown) => setNotice({ ok: false, text: message(e) }),
    );
  }, []);

  const problem = emailConfigError(form);
  const run = async (what: "save" | "test", fn: () => Promise<void>) => {
    setBusy(what);
    setNotice(null);
    try {
      await fn();
    } catch (e) {
      setNotice({ ok: false, text: message(e) });
    } finally {
      setBusy(null);
    }
  };
  const save = () =>
    run("save", async () => {
      const s = await api.email.configure({ ...form, host: form.host.trim(), from_addr: form.from_addr.trim(), username: form.username?.trim() || null, password: password || undefined });
      setState(s);
      setPassword("");
      setNotice({ ok: true, text: "Serveur d'envoi enregistré." });
    });
  const test = () =>
    run("test", async () => {
      const res = await api.email.test(parseRecipients(to));
      setNotice({ ok: res.ok, text: res.message });
    });
  const recipients = parseRecipients(to);

  return (
    <section className="atelier-card rounded-xl border border-border bg-surface p-5" aria-labelledby={`${id}-title`}>
      <div className="mb-1 flex items-center gap-2">
        <Mail className="size-4 text-muted" aria-hidden />
        <h2 id={`${id}-title`} className="flex-1 text-base font-semibold">
          E-mail des alertes
        </h2>
        {state?.config && (
          <button
            type="button"
            className="text-xs text-muted hover:text-fg"
            onClick={() =>
              run("save", async () => {
                setState(await api.email.forget());
                setForm(EMPTY);
              })
            }
          >
            Oublier
          </button>
        )}
      </div>
      <p className="mb-4 text-xs text-muted">
        Votre serveur d'envoi (celui de l'entreprise, ou d'une messagerie). {prefs?.online_mode ? "En ligne : tout serveur." : "Hors ligne : seulement un serveur de cette machine ou du réseau de l'entreprise."}
      </p>
      <div className="grid gap-3 sm:grid-cols-[1fr_7rem_9rem]">
        <label className="space-y-1 text-xs">
          <span className="text-muted">Serveur</span>
          <input className={`${input} w-full`} value={form.host} placeholder="smtp.entreprise.fr" onChange={(e) => setForm({ ...form, host: e.target.value })} spellCheck={false} />
        </label>
        <label className="space-y-1 text-xs">
          <span className="text-muted">Port</span>
          <input className={`${input} w-full`} inputMode="numeric" value={String(form.port)} onChange={(e) => setForm({ ...form, port: Number(e.target.value.replace(/\D/g, "")) || 0 })} />
        </label>
        <label className="space-y-1 text-xs">
          <span className="text-muted">Chiffrement</span>
          <select className={`${input} w-full`} value={form.security} onChange={(e) => {
            const security = e.target.value as SmtpSecurity;
            setForm({ ...form, security, port: form.port === PORTS[form.security] ? PORTS[security] : form.port });
          }}>
            <option value="starttls">STARTTLS (587)</option>
            <option value="ssl">SSL/TLS (465)</option>
            <option value="none">Aucun (réseau local)</option>
          </select>
        </label>
        <label className="space-y-1 text-xs">
          <span className="text-muted">Expéditeur</span>
          <input className={`${input} w-full`} value={form.from_addr} placeholder="alertes@entreprise.fr" onChange={(e) => setForm({ ...form, from_addr: e.target.value })} inputMode="email" spellCheck={false} />
        </label>
        <label className="space-y-1 text-xs">
          <span className="text-muted">Identifiant</span>
          <input className={`${input} w-full`} value={form.username ?? ""} onChange={(e) => setForm({ ...form, username: e.target.value })} autoComplete="off" spellCheck={false} />
        </label>
        <label className="space-y-1 text-xs">
          <span className="text-muted">Mot de passe</span>
          <input
            className={`${input} w-full`}
            type="password"
            value={password}
            placeholder={state?.has_password ? "••••••••" : ""}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
          />
        </label>
      </div>
      <p className="mt-2 flex items-center gap-1.5 text-[11px] text-muted">
        <ShieldCheck className="size-3.5" aria-hidden /> Mot de passe rangé dans le trousseau du système ; changer de serveur ou d'identifiant l'oublie.
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button type="button" className="atelier-btn-primary rounded-md px-3 py-1.5 text-xs disabled:opacity-50" disabled={!!problem || busy !== null} onClick={save}>
          {busy === "save" ? <Loader2 className="inline size-3.5 animate-spin" aria-hidden /> : "Enregistrer"}
        </button>
        <input
          aria-label="Destinataire du message d'essai"
          className={`${input} min-w-48 flex-1`}
          value={to}
          placeholder="vous@entreprise.fr"
          onChange={(e) => setTo(e.target.value)}
          inputMode="email"
        />
        <button
          type="button"
          className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-surface-2 disabled:opacity-50"
          disabled={!state?.config || !recipients.length || invalidRecipient(recipients) !== null || busy !== null}
          onClick={test}
        >
          {busy === "test" ? <Loader2 className="inline size-3.5 animate-spin" aria-hidden /> : "Envoyer un essai"}
        </button>
      </div>
      {problem && form.host && <p className="mt-2 text-[11px] text-muted">{problem}</p>}
      {notice && (
        <p role="status" className={`mt-2 text-xs ${notice.ok ? "text-fg" : "text-negative"}`}>
          {notice.text}
        </p>
      )}
    </section>
  );
}
