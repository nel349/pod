import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient } from "@tanstack/react-query";
import { App } from "./App.tsx";

const root = document.getElementById("root");
if (!root) throw new Error("the posting page has no #root to draw into: index.html and main.tsx disagree");

const client = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false } } });

createRoot(root).render(
  <StrictMode>
    <App client={client} />
  </StrictMode>,
);
