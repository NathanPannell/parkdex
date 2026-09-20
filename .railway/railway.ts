import { defineRailway, preserve, project, service } from "railway/iac";

export default defineRailway(() => {
  const api = service("api", {
    build: {
      builder: "DOCKERFILE",
      dockerfilePath: "backend/Dockerfile.api",
      watchPatterns: ["backend/**", "database/**"],
    },
    deploy: {
      preDeployCommand: ["python -m backend.app.migrate"],
      healthcheckPath: "/health",
      healthcheckTimeout: 60,
      restartPolicyMaxRetries: 3,
    },
    env: {
      API_PUBLIC_URL: preserve(),
      DATABASE_URL: preserve(),
      DATABASE_URL_UNPOOLED: preserve(),
      APP_PUBLIC_URL: preserve(),
      APP_ENVIRONMENT: preserve(),
      EMAIL_PROVIDER: preserve(),
      ENABLE_STAGING_FIELD_PLACES: preserve(),
      FRONTEND_ORIGINS: preserve(),
      GOOGLE_CLIENT_ID: preserve(),
      GOOGLE_CLIENT_SECRET: preserve(),
      GOOGLE_REDIRECT_URI: preserve(),
      MCP_PUBLIC_URL: preserve(),
      PHOTO_STORAGE_BACKEND: preserve(),
      R2_ENDPOINT: preserve(),
      R2_BUCKET: preserve(),
      R2_ACCESS_KEY_ID: preserve(),
      R2_SECRET_ACCESS_KEY: preserve(),
      R2_REGION: preserve(),
      RESEND_API_KEY: preserve(),
      RESEND_FROM: preserve(),
      APP_COMMIT_SHA: preserve(),
      APP_RELEASE_ID: preserve(),
    },
    replicas: { "us-west2": 1 },
  });

  return project("every-park", {
    resources: [api],
  });
});
