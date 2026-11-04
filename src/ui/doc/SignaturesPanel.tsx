import { CheckmarkCircle20Filled, DismissCircle20Filled, ErrorCircle20Filled, QuestionCircle20Regular } from "@fluentui/react-icons";
import type { SignatureInfo } from "../../core/signing";

export function signatureSummary(sigs: SignatureInfo[], trusted: Set<string>): { tone: "good" | "warn" | "bad"; text: string } | null {
  if (!sigs.length) return null;
  if (sigs.some((s) => s.status === "invalid")) return { tone: "bad", text: "At least one signature is invalid: the document was changed after signing." };
  const untrusted = sigs.filter((s) => s.status !== "unsupported" && !(s.fingerprint && trusted.has(s.fingerprint)));
  const names = [...new Set(sigs.map((s) => s.signer))].join(", ");
  if (sigs.every((s) => s.status === "valid" || s.status === "modified")) {
    const later = sigs.some((s) => s.status === "modified") && !sigs.some((s, i) => s.status === "valid" && i === sigs.length - 1);
    if (untrusted.length) return { tone: "warn", text: `Signed by ${names}. The signatures are intact, but ${untrusted.length === 1 ? "the signer's identity" : "some identities"} can't be confirmed.` };
    return { tone: later ? "warn" : "good", text: later ? `Signed by ${names}. The file was changed after the last signature.` : `Signed by ${names}. All signatures are valid.` };
  }
  return { tone: "warn", text: `Signed by ${names}. Some signatures couldn't be checked.` };
}

export function SignaturesPanel({
  sigs,
  loading,
  trusted,
  onTrust,
  onGo,
}: {
  sigs: SignatureInfo[];
  loading: boolean;
  trusted: Set<string>;
  onTrust: (fingerprint: string, trust: boolean) => void;
  onGo: (page: number) => void;
}) {
  if (loading) return <p className="sidebar__empty">Checking signatures…</p>;
  if (!sigs.length) return <p className="sidebar__empty">This document has no signatures.</p>;
  return (
    <ul className="sigs">
      {sigs.map((s, i) => {
        const isTrusted = !!s.fingerprint && trusted.has(s.fingerprint);
        const icon =
          s.status === "invalid" ? <DismissCircle20Filled className="sig-icon sig-icon--bad" /> :
          s.status === "unsupported" ? <QuestionCircle20Regular className="sig-icon" /> :
          s.status === "modified" || !isTrusted ? <ErrorCircle20Filled className="sig-icon sig-icon--warn" /> :
          <CheckmarkCircle20Filled className="sig-icon sig-icon--good" />;
        return (
          <li key={i} className="sig">
            <button className="sig__head" onClick={() => s.page != null && onGo(s.page)}>
              {icon}
              <span>
                <span className="sig__name">{s.signer}</span>
                <span className="sig__when">{s.signedAt ? new Date(s.signedAt).toLocaleString() : "Time unknown"}</span>
              </span>
            </button>
            <p className="sig__detail">{s.detail}</p>
            {s.status !== "invalid" && s.status !== "unsupported" && (
              <p className="sig__detail">
                {isTrusted
                  ? "You trust this signer's certificate."
                  : s.selfSigned
                    ? "Identity not confirmed: the certificate is self-signed."
                    : `Identity not confirmed: issued by ${s.issuer ?? "an unknown issuer"}, which isn't in your trusted list.`}
              </p>
            )}
            {s.certValidAtSigning === false && <p className="sig__detail sig__detail--bad">The certificate wasn't valid at the time of signing.</p>}
            <dl className="sig__meta">
              {s.reason && (<><dt>Reason</dt><dd>{s.reason}</dd></>)}
              {s.location && (<><dt>Location</dt><dd>{s.location}</dd></>)}
              {s.email && (<><dt>Email</dt><dd>{s.email}</dd></>)}
              {s.issuer && (<><dt>Issuer</dt><dd>{s.issuer}</dd></>)}
              {s.page != null && (<><dt>Page</dt><dd>{s.page + 1}</dd></>)}
            </dl>
            {s.fingerprint && s.status !== "unsupported" && (
              <button className="button button--small" onClick={() => onTrust(s.fingerprint!, !isTrusted)} title={s.fingerprint}>
                {isTrusted ? "Stop trusting this signer" : "Trust this signer"}
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
