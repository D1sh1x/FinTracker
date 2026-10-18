import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError } from "./api";
import App from "./App";
import { MobileRoot } from "./MobileRoot";
import "./styles.css";
import "@fontsource-variable/manrope";

const client = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      retry: (count, error) =>
        count < 2 &&
        error instanceof ApiError &&
        (error.status === 0 || error.status >= 500),
    },
  },
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={client}>
      <MobileRoot>
        <App />
      </MobileRoot>
    </QueryClientProvider>
  </React.StrictMode>,
);
