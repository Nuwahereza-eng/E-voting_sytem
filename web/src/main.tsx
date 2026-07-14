import { Buffer } from "buffer";
// @stellar/stellar-sdk needs `Buffer` and `global` in the browser.
(window as unknown as { Buffer: typeof Buffer }).Buffer = Buffer;
(window as unknown as { global: unknown }).global = window;

import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
