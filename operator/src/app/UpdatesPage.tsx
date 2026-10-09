import { Placeholder } from "../shell/Placeholder";

export function UpdatesPage() {
  return (
    <Placeholder
      eyebrow="Over-the-air updates"
      title="Updates"
      lede="What each channel's installed apps download on their next launch, and a way to change it without a store release."
      items={[
        "Each channel's live bundle from app-bundles/channels/<channel>/current.json, with its minimum native build and generation",
        "Publish history per channel",
        "Publish or roll back: point a channel at a bundle already in R2, guarded by a generation check",
        "A setup checklist: CDN worker redeploy and signing keys",
      ]}
    />
  );
}
