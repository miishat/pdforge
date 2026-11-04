import { LockClosed20Regular } from "@fluentui/react-icons";
import { useState } from "react";

interface Props {
  name: string;
  wrongPassword: boolean;
  onSubmit: (password: string) => void;
  onCancel: () => void;
}

export function PasswordPrompt({ name, wrongPassword, onSubmit, onCancel }: Props) {
  const [password, setPassword] = useState("");
  return (
    <main className="center-panel">
      <form
        className="panel"
        onSubmit={(e) => {
          e.preventDefault();
          if (password) onSubmit(password);
        }}
      >
        <div className="panel__icon"><LockClosed20Regular /></div>
        <h1 className="panel__title">This PDF is password-protected</h1>
        <p className="panel__text">Enter the password to open <strong>{name}</strong>.</p>
        <input
          className={`field ${wrongPassword ? "field--invalid" : ""}`}
          type="password"
          aria-label="Password"
          aria-invalid={wrongPassword}
          aria-describedby={wrongPassword ? "pw-error" : undefined}
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {wrongPassword && <p id="pw-error" className="panel__error">That password isn't right. Try again.</p>}
        <div className="panel__actions">
          <button type="button" className="button" onClick={onCancel}>Cancel</button>
          <button type="submit" className="button button--primary" disabled={!password}>Open</button>
        </div>
      </form>
    </main>
  );
}
