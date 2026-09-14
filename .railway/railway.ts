import { defineRailway, github, preserve, project, service } from "railway/iac";

export default defineRailway(() => {
  const repository = github("NathanPannell/every-park");

  const api = service("api", {
    source: repository,
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
    },
    replicas: { "us-west2": 1 },
  });

  return project("every-park", {
    resources: [api],
  });
});
