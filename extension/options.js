const api = typeof browser !== "undefined" ? browser : chrome;
const $ = (id) => document.getElementById(id);

(async () => {
  const r = await api.storage.local.get(["server"]);
  $("server").value = r.server || "http://localhost:3001";
})();

$("save").addEventListener("click", async () => {
  const v = $("server").value.trim().replace(/\/+$/, "");
  await api.storage.local.set({ server: v || "http://localhost:3001" });
  const saved = $("saved");
  saved.hidden = false;
  setTimeout(() => (saved.hidden = true), 1500);
});
