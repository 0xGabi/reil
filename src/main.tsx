import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./index.css";
import { App } from "./App.tsx";
import { AppKitProvider } from "./provider/index.tsx";
import { ThemeProvider } from "@mui/material";
import { theme } from "./theme.ts";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppKitProvider>
      <ThemeProvider theme={theme}>
        <App />
      </ThemeProvider>
    </AppKitProvider>
  </StrictMode>
);
