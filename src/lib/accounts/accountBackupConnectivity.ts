import {
  getContentConnectivity,
  subscribeContentConnectivity,
  type ContentConnectivity,
} from "../content/transport";

export type AccountBackupConnectivity = { connected: boolean; allowed: boolean };

/** Account backup can use any active internet connection on each platform. */
export function mapAccountBackupConnectivity(connectivity: ContentConnectivity): AccountBackupConnectivity {
  const connected = connectivity.connected === true;
  return {
    connected,
    allowed: connected,
  };
}

/** Read account-backup availability, optionally mapping an already-read connectivity value. */
export async function getAccountBackupConnectivity(
  knownConnectivity?: ContentConnectivity,
): Promise<AccountBackupConnectivity> {
  const connectivity = knownConnectivity ?? await getContentConnectivity();
  return mapAccountBackupConnectivity(connectivity);
}

/** Subscribe to account-backup availability using the shared connected-network rule. */
export function subscribeAccountBackupConnectivity(
  listener: (connectivity: AccountBackupConnectivity) => void,
): () => void {
  return subscribeContentConnectivity((connectivity) => {
    listener(mapAccountBackupConnectivity(connectivity));
  });
}

/** Return false when connectivity cannot be read so callers can safely pause backup work. */
export async function isAccountBackupAvailable(knownConnectivity?: ContentConnectivity): Promise<boolean> {
  try {
    return (await getAccountBackupConnectivity(knownConnectivity)).allowed;
  } catch {
    return false;
  }
}
