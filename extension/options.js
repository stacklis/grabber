const api = typeof browser !== "undefined" ? browser : chrome;
const $ = (id) => document.getElementById(id);

const DEFAULT_SERVER = "http://100.99.119.80:3001";

(async () => {
  const r = await api.storage.local.get(["server"]);
  $("server").value = r.server || DEFAULT_SERVER;
})();

async function saveServer(value) {
  const v = (value || "").trim().replace(/\/+$/, "");
  await api.storage.local.set({ server: v || DEFAULT_SERVER });
  const saved = $("saved");
  saved.hidden = false;
  setTimeout(() => (saved.hidden = true), 1500);
}

$("save").addEventListener("click", async () => {
  await saveServer($("server").value);
});

$("set-tailscale").addEventListener("click", async () => {
  $("server").value = "http://100.99.119.80:3001";
  await saveServer($("server").value);
});

$("set-localhost").addEventListener("click", async () => {
  $("server").value = "http://localhost:3001";
  await saveServer($("server").value);
});
