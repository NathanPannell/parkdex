export type NativePackageInstallInfo = {
  packageName: string;
  firstInstallTime: number;
  lastUpdateTime: number;
  versionCode: number;
};

export type OnboardingCompletion = {
  onboarded: boolean;
  buildId: string | null;
  packageInstallIdentity: string | null;
};

export type CurrentInstall = {
  buildId: string;
  packageInstallIdentity: string | null;
  native: boolean;
};

/** Package timestamps change on reinstall and update, even when the source SHA is unchanged. */
export function packageInstallIdentity(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const info = value as Partial<NativePackageInstallInfo>;
  if (typeof info.packageName !== "string" || !/^[A-Za-z0-9_.]+$/.test(info.packageName)) return null;
  if (!Number.isSafeInteger(info.firstInstallTime) || info.firstInstallTime! <= 0) return null;
  if (!Number.isSafeInteger(info.lastUpdateTime) || info.lastUpdateTime! <= 0) return null;
  if (!Number.isSafeInteger(info.versionCode) || info.versionCode! < 0) return null;
  return [info.packageName, info.firstInstallTime, info.lastUpdateTime, info.versionCode].join(":");
}

export function onboardingMatchesInstall(saved: OnboardingCompletion, current: CurrentInstall): boolean {
  if (!saved.onboarded || !saved.buildId || saved.buildId !== current.buildId) return false;
  if (current.native && !current.packageInstallIdentity) return false;
  return saved.packageInstallIdentity === current.packageInstallIdentity;
}
