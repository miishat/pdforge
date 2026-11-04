import { Certificate20Regular, Warning16Regular } from "@fluentui/react-icons";
import { useState } from "react";
import { engine } from "../../core/client";
import { pickFile, type PickedFile } from "../../platform";
import { Dialog } from "../components/Dialog";
import type { SavedSignature } from "./signatures";

export interface CertSignChoice {
  token: number;
  signer: string;
  reason: string;
  location: string;
  image: SavedSignature | null;
}

const REASONS = ["I approve this document", "I am the author of this document", "I have reviewed this document", "I agree to the terms"];

export function CertSignDialog({
  signatures,
  onReady,
  onClose,
  inField,
}: {
  signatures: SavedSignature[];
  onReady: (c: CertSignChoice) => void;
  onClose: () => void;
  /** Signing into an existing field (no box to draw). */
  inField: boolean;
}) {
  const [file, setFile] = useState<PickedFile | null>(null);
  const [password, setPassword] = useState("");
  const [identity, setIdentity] = useState<Awaited<ReturnType<typeof openId>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState(REASONS[0]);
  const [location, setLocation] = useState("");
  const sigs = signatures.filter((s) => s.kind === "signature");
  const [imageId, setImageId] = useState<string>(sigs[0]?.id ?? "");

  const unlock = async () => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      setIdentity(await openId(file.bytes, password));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const now = Date.now();
  const expired = identity && new Date(identity.validTo).getTime() < now;
  const notYet = identity && new Date(identity.validFrom).getTime() > now;

  return (
    <Dialog
      title="Sign with a certificate"
      onClose={() => {
        if (identity) void engine().call("forgetIdentity", identity.token);
        onClose();
      }}
      width={520}
      footer={
        identity ? (
          <>
            <button className="button" onClick={() => setIdentity(null)}>Back</button>
            <button
              className="button button--primary"
              disabled={!!expired || !!notYet}
              onClick={() =>
                onReady({ token: identity.token, signer: identity.name, reason, location, image: sigs.find((s) => s.id === imageId) ?? null })
              }
            >
              {inField ? "Sign" : "Continue: draw the signature box"}
            </button>
          </>
        ) : (
          <>
            <button className="button" onClick={onClose}>Cancel</button>
            <button className="button button--primary" disabled={!file || busy} onClick={unlock}>
              {busy ? "Opening…" : "Open certificate"}
            </button>
          </>
        )
      }
    >
      {!identity ? (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            void unlock();
          }}
        >
          <p className="muted">Choose your digital ID: a .pfx or .p12 file, for example one exported from Windows or issued by your organization.</p>
          <div className="file-pick">
            <button
              type="button"
              className="button"
              onClick={async () => {
                const f = await pickFile({ name: "Digital IDs", extensions: ["pfx", "p12"] });
                if (f) {
                  setFile(f);
                  setError(null);
                }
              }}
            >
              <Certificate20Regular /> Choose digital ID…
            </button>
            <span className="file-pick__name">{file?.name ?? "No file chosen"}</span>
          </div>
          <label className="label">
            Password
            <input className={`field ${error ? "field--invalid" : ""}`} type="password" value={password} onChange={(e) => setPassword(e.target.value)} aria-label="Certificate password" />
          </label>
          {error && <p className="panel__error">{error}</p>}
          <button type="submit" hidden />
        </form>
      ) : (
        <div className="stack">
          <div className="identity">
            <Certificate20Regular />
            <div>
              <div className="identity__name">{identity.name}</div>
              <div className="muted">
                {identity.email ? `${identity.email} · ` : ""}Issued by {identity.issuer} · valid until {new Date(identity.validTo).toLocaleDateString()}
              </div>
            </div>
          </div>
          {expired && <p className="panel__error">This certificate expired on {new Date(identity.validTo).toLocaleDateString()}. Signatures made with it won't be valid.</p>}
          {notYet && <p className="panel__error">This certificate isn't valid until {new Date(identity.validFrom).toLocaleDateString()}.</p>}
          {identity.issuer === identity.name && (
            <p className="note">
              <Warning16Regular /> This is a self-signed certificate. Others will see your signature as intact, but can't confirm who you are
              unless they choose to trust it.
            </p>
          )}
          <label className="label">
            Reason
            <input className="field" list="sign-reasons" value={reason} onChange={(e) => setReason(e.target.value)} />
            <datalist id="sign-reasons">{REASONS.map((r) => <option key={r} value={r} />)}</datalist>
          </label>
          <label className="label">
            <span>
              Location <span className="muted">(optional)</span>
            </span>
            <input className="field" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="City, country" />
          </label>
          {sigs.length > 0 && (
            <label className="label">
              Appearance
              <select className="select select--wide" value={imageId} onChange={(e) => setImageId(e.target.value)}>
                <option value="">Text only</option>
                {sigs.map((s, i) => (
                  <option key={s.id} value={s.id}>
                    Text and my handwritten signature{sigs.length > 1 ? ` ${i + 1}` : ""}
                  </option>
                ))}
              </select>
            </label>
          )}
          <p className="muted">Signing saves the document. You'll choose where to save the signed copy.</p>
        </div>
      )}
    </Dialog>
  );
}

function openId(bytes: Uint8Array, password: string) {
  return engine().call("openIdentity", bytes.slice(), password);
}
