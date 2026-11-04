import { DocumentError20Regular } from "@fluentui/react-icons";

export function ErrorPanel({ name, message, onOpen }: { name: string; message: string; onOpen: () => void }) {
  return (
    <main className="center-panel">
      <div className="panel" role="alert">
        <div className="panel__icon panel__icon--danger"><DocumentError20Regular /></div>
        <h1 className="panel__title">Couldn't open {name}</h1>
        <p className="panel__text">{message}</p>
        <div className="panel__actions">
          <button className="button button--primary" onClick={onOpen} autoFocus>Open another file</button>
        </div>
      </div>
    </main>
  );
}
