import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "app.fintrack.personal",
  appName: "ФинТрек",
  webDir: "dist",
  backgroundColor: "#f5f3fa",
  loggingBehavior: "none",
  android: {
    allowMixedContent: false,
    backgroundColor: "#f5f3fa",
  },
  plugins: {
    SystemBars: { insetsHandling: "native" },
  },
};

export default config;
