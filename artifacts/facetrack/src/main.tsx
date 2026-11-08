import { createRoot } from "react-dom/client";
import { setAuthTokenGetter, setBaseUrl } from "@workspace/api-client-react";
import App from "./App";
import "./index.css";

const apiOrigin = import.meta.env.VITE_API_ORIGIN?.trim();
if (apiOrigin) {
  const parsedApiOrigin = new URL(apiOrigin);
  if (
    !["http:", "https:"].includes(parsedApiOrigin.protocol) ||
    parsedApiOrigin.pathname !== "/" ||
    parsedApiOrigin.search ||
    parsedApiOrigin.hash
  ) {
    throw new Error(
      "VITE_API_ORIGIN must be an HTTP(S) origin without a path, query, or fragment.",
    );
  }
  setBaseUrl(parsedApiOrigin.origin);
} else {
  setBaseUrl(null);
}

setAuthTokenGetter(() => localStorage.getItem("ft_token"));

createRoot(document.getElementById("root")!).render(<App />);
