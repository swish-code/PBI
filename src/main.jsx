import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { AnimatePresence } from "framer-motion";
import App from "./App.jsx";
import SplashScreen from "./SplashScreen.jsx";
import "./styles.css";

// Root wraps the app with the startup splash so it overlays login/boot/dashboard
// and dismisses itself after the intro animation.
function Root() {
  const [splash, setSplash] = useState(true);
  return (
    <>
      <App />
      <AnimatePresence>{splash && <SplashScreen onDone={() => setSplash(false)} />}</AnimatePresence>
    </>
  );
}

createRoot(document.getElementById("root")).render(<Root />);
