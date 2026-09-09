import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "app.parkdex",
  appName: "Parkdex",
  webDir: "out",
  backgroundColor: "#173d32",
  server: {
    hostname: "localhost",
    androidScheme: "https",
  },
};

export default config;
