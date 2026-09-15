import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";

const readClientFile = (path: string) =>
  readFileSync(`packages/client/src/${path}`, "utf8");

describe("Hermes configuration navigation", () => {
  it("moves Hermes-only pages into the dedicated sidebar", () => {
    const app = readClientFile("App.vue");
    const appSidebar = readClientFile("components/layout/AppSidebar.vue");
    const configSidebar = readClientFile(
      "components/layout/HermesConfigSidebar.vue",
    );
    const sharedSidebarStyles = readClientFile("styles/_agent-config-sidebar.scss");
    const router = readClientFile("router/index.ts");

    expect(app).toContain("@/components/layout/HermesConfigSidebar.vue");
    expect(app).toContain("route.meta?.hermesConfig === true");
    expect(app).toContain('v-if="!isLoginPage && usesHermesConfigSidebar"');
    expect(app).toContain("if (usesHermesConfigSidebar.value)");
    expect(app).toContain("return appStore.sidebarCollapsed ? 84 : 260");

    for (const name of [
      "hermes.jobs",
      "hermes.kanban",
      "hermes.channels",
      "hermes.skills",
      "hermes.plugins",
      "hermes.mcp",
      "hermes.memory",
      "hermes.journey",
      "hermes.configSettings",
    ]) {
      expect(configSidebar).toContain(`name: '${name}'`);
    }
    expect(configSidebar).toContain("name: 'hermes.agentManager'");
    expect(configSidebar).toContain('t("sidebar.backToChat")');
    expect(configSidebar).not.toContain("ProfileSelector");
    expect(configSidebar).not.toContain("ModelSelector");
    expect(configSidebar).not.toContain("hermes-config-header");
    expect(configSidebar).toContain('class="hermes-config-collapse"');
    expect(configSidebar).toContain("appStore.toggleSidebarCollapsed()");
    expect(configSidebar).toContain("collapsed: appStore.sidebarCollapsed");
    expect(configSidebar).toContain('@include agent-config-sidebar.layout("hermes")');
    const mainGearPath = "M19.4 15a1.65 1.65 0 0 0 .33 1.82";
    expect(appSidebar).toContain(mainGearPath);
    expect(configSidebar).toContain(mainGearPath);
    expect(sharedSidebarStyles).toContain("padding: 8px 12px 20px");
    expect(sharedSidebarStyles).toContain("font-size: 14px");
    expect(sharedSidebarStyles).toContain("width: 28px");
    expect(sharedSidebarStyles).toContain("padding: 8px 8px 12px");

    for (const label of [
      "sidebar.kanban",
      "sidebar.channels",
      "sidebar.skills",
      "sidebar.plugins",
      "sidebar.mcp",
      "sidebar.memory",
      "sidebar.journey",
    ]) {
      expect(appSidebar).not.toContain(`t(\"${label}\")`);
    }
    expect(appSidebar).not.toContain("<span>Hermes</span>");
    expect(appSidebar).not.toContain("nav-group-label");
    expect(appSidebar).not.toContain("groupLabel(");
    expect(appSidebar.indexOf('t("sidebar.petdex")')).toBeGreaterThan(
      appSidebar.indexOf('t("sidebar.theme")'),
    );
    expect(router).toContain("path: '/hermes/config/settings'");
    expect(router.match(/meta: \{ hermesConfig: true \}/g)).toHaveLength(9);
  });

  it("keeps Studio settings separate and migrates Hermes setting tabs", () => {
    const settingsView = readClientFile("views/hermes/SettingsView.vue");
    const hermesSettings = readClientFile(
      "views/hermes/HermesSettingsView.vue",
    );
    const agentManager = readClientFile("views/hermes/AgentManagerView.vue");

    expect(settingsView).not.toContain("GatewayAutoStartSettings");
    expect(settingsView).not.toContain("AgentSettings");
    expect(settingsView).not.toContain("MemorySettings");
    expect(settingsView).not.toContain("SessionSettings");
    expect(settingsView).toContain('name: "hermes.configSettings"');
    expect(settingsView).toContain(
      'tab === "agent" || tab === "memory" || tab === "session" || tab === "gateway"',
    );

    expect(hermesSettings).toContain("<AgentSettings />");
    expect(hermesSettings).toContain("<GatewayAutoStartSettings />");
    expect(hermesSettings).toContain("<MemorySettings />");
    expect(hermesSettings).toContain("<SessionSettings />");
    expect(hermesSettings).toContain("await settingsStore.fetchSettings()");
    expect(agentManager).toContain(
      "router.push({ name: 'hermes.configSettings' })",
    );
    expect(agentManager).toContain('v-if="hermesDetected"');
    expect(agentManager).toContain("t('agentManager.hermesSettings')");
  });
});
