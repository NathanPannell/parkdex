import { defineRailway, preserve, project, service } from "railway/iac";

export default defineRailway(() => {
  const worker = service("worker", {
    build: {
      builder: "DOCKERFILE",
      dockerfilePath: "backend/Dockerfile.worker",
      watchPatterns: ["backend/**", "database/**"],
    },
    deploy: {
      preDeployCommand: ["python -m backend.app.migrate"],
      restartPolicyType: "ON_FAILURE",
      restartPolicyMaxRetries: 5,
    },
    env: {
      DATABASE_URL: preserve(),
      DATABASE_URL_UNPOOLED: preserve(),
      APP_COMMIT_SHA: preserve(),
      APP_RELEASE_ID: preserve(),
    },
    replicas: { "us-west2": 1 },
  });

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
      restartPolicyType: "ON_FAILURE",
      restartPolicyMaxRetries: 3,
    },
    env: {
      DATABASE_URL: preserve(),
      DATABASE_URL_UNPOOLED: preserve(),
      FRONTEND_ORIGINS: preserve(),
      APP_COMMIT_SHA: preserve(),
      APP_RELEASE_ID: preserve(),
    },
    replicas: { "us-west2": 1 },
  });

  return project("every-park", {
    resources: [worker, api],
  });
});
