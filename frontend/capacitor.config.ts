import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "app.parkdex",
  appName: "Parkdex",
  webDir: "out",
  backgroundColor: "#173d32",
  android: {
    loggingBehavior: "none",
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
