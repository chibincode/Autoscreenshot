import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Agentation } from "agentation";
import { App } from "./App";
import { DesignSystemPage } from "./design-system/DesignSystemPage";
import { resolveAppSurface } from "./app-route";
import "./styles.css";
import "./ui/button.css";

const root = document.getElementById("root");
if (!root) {
  throw new Error("Root element not found");
}

const surface = resolveAppSurface(window.location.pathname);
document.title = surface === "design-system" ? "Autoscreenshot Design System" : "Autoscreenshot Console";

createRoot(root).render(
  <StrictMode>
    <>
      {surface === "design-system" ? <DesignSystemPage /> : <App />}
      {import.meta.env.DEV ? <Agentation /> : null}
    </>
  </StrictMode>,
);
