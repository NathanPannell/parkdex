import { motion } from "motion/react";
import { Icon } from "../components/Icon";
import { useToast } from "../components/Toast";
import { listItem, listParent, press } from "../lib/motion";
import { enterFullscreen, fullscreenOffer, installOffer, promptInstall, useWebApp } from "../lib/webApp";

/**
 * Settings rows for Parkdex in a phone browser: install it, or go full screen again after
 * leaving full screen. Nothing shows in native builds, once installed, or on a desktop.
 */
export function WebAppSettings() {
  const env = useWebApp();
  const toast = useToast();
  const install = installOffer(env);
  const fullscreen = fullscreenOffer(env);
  if (!install && !fullscreen) return null;

  return (
    <motion.section className="account-card card account-section" aria-label="Parkdex on this phone" variants={listParent} initial="hidden" animate="show">
      {install === "prompt" && (
        <motion.button
          variants={listItem}
          whileTap={press}
          className="account-setting account-setting--button"
          onClick={() => void promptInstall().then((outcome) => {
            if (outcome === "accepted") toast("Parkdex is on your home screen", "kip");
          })}
        >
          <span className="account-setting__icon" aria-hidden="true"><Icon name="download" size={20} /></span>
          <span className="account-setting__text">
            <strong>Install Parkdex</strong>
            <span>Full screen, from your home screen</span>
          </span>
          <Icon name="next" size={18} />
        </motion.button>
      )}
      {install === "apple-hint" && (
        <motion.div variants={listItem} className="account-setting" style={{ cursor: "default" }}>
          <span className="account-setting__icon" aria-hidden="true"><Icon name="share" size={20} /></span>
          <span className="account-setting__text">
            <strong>Install Parkdex</strong>
            <span>Tap Share, then Add to Home Screen</span>
          </span>
        </motion.div>
      )}
      {fullscreen && (
        <motion.button variants={listItem} whileTap={press} className="account-setting account-setting--button" onClick={() => void enterFullscreen()}>
          <span className="account-setting__icon" aria-hidden="true"><Icon name="corners" size={20} /></span>
          <span className="account-setting__text">
            <strong>Go full screen</strong>
            <span>Hide the browser bars</span>
          </span>
          <Icon name="next" size={18} />
        </motion.button>
      )}
    </motion.section>
  );
}
