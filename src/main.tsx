import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { engineDebugState } from "./core/client";
import "./styles/tokens.css";
import "./styles/app.css";

// Read by the end-to-end tests when one fails, to show what the engine was still busy with.
(window as unknown as { __pdforgeEngine: typeof engineDebugState }).__pdforgeEngine = engineDebugState;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
