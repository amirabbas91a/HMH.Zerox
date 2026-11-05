import { ClientEnv } from "./ClientEnv";

// The account/shop API origin (api.<audience>). Lives apart from Api.ts so
// modules that Api.ts itself depends on (ServerList) can reach it without an
// import cycle; Api.ts re-exports both for its existing importers.

export function getApiBase() {
  // HMH.Zerox self-host: a build-time API_DOMAIN points the client at our
  // own game server (which answers /cluster.json itself) instead of
  // api.<audience>. Unset keeps the upstream behaviour.
  const apiDomain = process.env.API_DOMAIN;
  if (apiDomain) {
    return `https://${apiDomain}`;
  }

  const domainname = getAudience();

  if (domainname === "localhost") {
    return localStorage.getItem("apiHost") ?? "http://localhost:8787";
  }

  return `https://api.${domainname}`;
}

export function getAudience() {
  // Sourced from BOOTSTRAP_CONFIG (server/desktop-injected) rather than
  // window.location, so the desktop app (app://openfront) targets real infra.
  return ClientEnv.jwtAudience();
}
