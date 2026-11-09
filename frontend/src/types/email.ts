/** Miroir de backend/app/schemas/email.py : serveur d'envoi des alertes (mot de passe au trousseau). */

export type SmtpSecurity = "starttls" | "ssl" | "none";

export interface EmailConfig {
  host: string;
  port: number;
  security: SmtpSecurity;
  username: string | null;
  from_addr: string;
}

export interface EmailConfigInput extends EmailConfig {
  /** Absent = inchangé, vide = effacé. */
  password?: string | null;
}

export interface EmailState {
  config: EmailConfig | null;
  has_password: boolean;
}

export interface EmailTestResult {
  ok: boolean;
  message: string;
}
