"use client";

import { LoaderCircle, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

type PlaceVisuals3DProps = {
  src: string;
  label: string;
};

function disposeModel(root: THREE.Object3D) {
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    object.geometry.dispose();
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      for (const value of Object.values(material)) {
        if (value instanceof THREE.Texture) value.dispose();
      }
      material.dispose();
    }
  });
}

export default function PlaceVisuals3D({ src, label }: PlaceVisuals3DProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    let disposed = false;
    let frame = 0;
    let model: THREE.Object3D | null = null;
    let observer: ResizeObserver | null = null;
    let resizeHandler: (() => void) | null = null;
    let renderer: THREE.WebGLRenderer | null = null;
    let controls: OrbitControls | null = null;
    const controller = new AbortController();
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf2f0e4);
    const camera = new THREE.PerspectiveCamera(38, 1, 0.01, 1000);

    try {
      renderer = new THREE.WebGLRenderer({ alpha: false, antialias: true, powerPreference: "low-power" });
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      mount.replaceChildren(renderer.domElement);
      controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.enablePan = false;
      controls.minDistance = 1.6;
      controls.maxDistance = 24;
      controls.touches.ONE = THREE.TOUCH.ROTATE;
      controls.touches.TWO = THREE.TOUCH.DOLLY_PAN;
      controlsRef.current = controls;
      scene.add(new THREE.HemisphereLight(0xffffff, 0x64755c, 2.1));
      const keyLight = new THREE.DirectionalLight(0xffffff, 2.4);
      keyLight.position.set(-4, 8, 7);
      scene.add(keyLight);

      const resize = () => {
        if (!renderer || disposed) return;
        const width = Math.max(1, mount.clientWidth);
        const height = Math.max(1, mount.clientHeight);
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
        renderer.setSize(width, height, false);
      };
      resize();
      if (typeof ResizeObserver !== "undefined") {
        observer = new ResizeObserver(resize);
        observer.observe(mount);
      } else {
        resizeHandler = resize;
        window.addEventListener("resize", resize);
      }

      const renderFrame = () => {
        if (disposed || !renderer) return;
        frame = window.requestAnimationFrame(renderFrame);
        controls?.update();
        renderer.render(scene, camera);
      };
      frame = window.requestAnimationFrame(renderFrame);

      void (async () => {
        try {
          const response = await fetch(src, { signal: controller.signal, cache: "force-cache" });
          if (!response.ok) throw new Error(`The 3D terrain model returned ${response.status}.`);
          const bytes = await response.arrayBuffer();
          const loader = new GLTFLoader();
          const gltf = await loader.parseAsync(bytes, new URL(".", src).href);
          if (disposed) {
            disposeModel(gltf.scene);
            return;
          }
          const bounds = new THREE.Box3().setFromObject(gltf.scene);
          const size = bounds.getSize(new THREE.Vector3());
          const center = bounds.getCenter(new THREE.Vector3());
          const longestSide = Math.max(size.x, size.y, size.z);
          if (!Number.isFinite(longestSide) || longestSide <= 0) throw new Error("The 3D terrain model has no visible geometry.");

          const modelRoot = new THREE.Group();
          model = modelRoot;
          gltf.scene.position.sub(center);
          modelRoot.add(gltf.scene);
          const fittedSize = 4.2;
          modelRoot.scale.setScalar(fittedSize / longestSide);
          scene.add(modelRoot);
          camera.position.set(0, fittedSize * 0.62, fittedSize * 2.1);
          camera.lookAt(0, 0, 0);
          camera.updateProjectionMatrix();
          if (controls) {
            controls.target.set(0, 0, 0);
            controls.minDistance = fittedSize * 0.42;
            controls.maxDistance = fittedSize * 5.5;
            controls.saveState();
          }
          setStatus("ready");
        } catch (caught) {
          if (disposed || controller.signal.aborted) return;
          setStatus("error");
          setError(caught instanceof Error ? caught.message : "The 3D terrain model could not be opened.");
        }
      })();
    } catch (caught) {
      const message = caught instanceof Error ? "3D terrain is not supported by this device." : "The 3D viewer could not be started.";
      queueMicrotask(() => {
        if (disposed) return;
        setStatus("error");
        setError(message);
      });
    }

    return () => {
      disposed = true;
      controller.abort();
      window.cancelAnimationFrame(frame);
      observer?.disconnect();
      if (resizeHandler) window.removeEventListener("resize", resizeHandler);
      controls?.dispose();
      controlsRef.current = null;
      if (model) disposeModel(model);
      renderer?.dispose();
      renderer?.domElement.remove();
      mount.replaceChildren();
    };
  }, [src, retryCount]);

  return (
    <div className="place-visuals-3d-shell">
      <div ref={mountRef} className="place-visuals-3d-canvas" role="region" aria-label={label} />
      {status === "loading" && <p className="place-visuals-3d-status" role="status"><LoaderCircle size={18} className="place-visuals-spin" />Loading 3D terrain…</p>}
      {status === "error" && <div className="place-visuals-3d-error" role="alert"><p>{error}</p><button type="button" onClick={() => { setStatus("loading"); setError(""); setRetryCount((count) => count + 1); }}>Retry 3D model</button></div>}
      {status === "ready" && <button className="place-visuals-reset" type="button" onClick={() => controlsRef.current?.reset()}><RotateCcw size={15} />Reset view</button>}
    </div>
  );
}
