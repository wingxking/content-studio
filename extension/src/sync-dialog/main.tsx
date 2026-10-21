import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../popup/styles/globals.css";
import { SyncDialogPage } from "./SyncDialogPage";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <SyncDialogPage />
  </StrictMode>,
);
