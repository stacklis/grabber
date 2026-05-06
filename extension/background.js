const api = typeof browser !== "undefined" ? browser : chrome;

const MENU_ITEMS = [
  { id: "grabber-page", title: "Grab this page", contexts: ["page"] },
  { id: "grabber-link", title: "Grab this link", contexts: ["link"] },
  { id: "grabber-image", title: "Grab this image", contexts: ["image"] },
  { id: "grabber-video", title: "Grab this video", contexts: ["video"] },
  { id: "grabber-audio", title: "Grab this audio", contexts: ["audio"] },
];

if (api.contextMenus && api.runtime.onInstalled) {
  api.runtime.onInstalled.addListener(() => {
    try {
      api.contextMenus.removeAll(() => {
        for (const item of MENU_ITEMS) {
          try {
            api.contextMenus.create(item);
          } catch (_) {}
        }
      });
    } catch (_) {}
  });

  api.contextMenus.onClicked.addListener(async (info, tab) => {
    let url = "";
    switch (info.menuItemId) {
      case "grabber-page":
        url = info.pageUrl || tab?.url || "";
        break;
      case "grabber-link":
        url = info.linkUrl || "";
        break;
      case "grabber-image":
      case "grabber-video":
      case "grabber-audio":
        url = info.srcUrl || info.pageUrl || "";
        break;
    }
    if (!url) return;
    const r = await api.storage.local.get(["server"]);
    const server = (r.server || "http://localhost:3001").replace(/\/+$/, "");
    const target = `${server}/?url=${encodeURIComponent(url)}`;
    await api.tabs.create({ url: target });
  });
}
