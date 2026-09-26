import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "app.parkdex",
  appName: "Parkdex",
  webDir: "dist",
  backgroundColor: "#FF5A1F",
  android: {
    loggingBehavior: "debug",
  },
  server: {
    hostname: "localhost",
    androidScheme: "https",
  },
  plugins: {
    SystemBars: {
      insetsHandling: "native",
      initialViewportFitValueHint: "cover",
    },
  },
};

export default config;
