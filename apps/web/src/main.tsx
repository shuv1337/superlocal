import React from "react";
import { createRoot } from "react-dom/client";
import ApplicationGate from "./ApplicationGate";
import { startBrowserLogCapture } from "./browser-logs";
import "./style.css";

startBrowserLogCapture();

// Installed iOS web app: with a translucent status bar, iOS lays the page out in a viewport that is
// shorter than the screen by the status-bar inset (every viewport unit and `100%` agree on the
// short value), leaving a dead band under the bottom bars. The screen size is the only truthful
// measure there, so mobile.css sizes the app from it. Other browsers never set this property.
if ((navigator as Navigator & { standalone?: boolean }).standalone === true) {
  const portrait = matchMedia("(orientation: portrait)");
  // iOS reports screen.width/height for portrait regardless of rotation.
  const size = () => document.documentElement.style.setProperty("--standalone-height", `${portrait.matches ? screen.height : screen.width}px`);
  size();
  portrait.addEventListener("change", size);
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ApplicationGate />
  </React.StrictMode>,
);
