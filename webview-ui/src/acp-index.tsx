// Initialize source maps for ACP mode
import { initializeSourceMaps, exposeSourceMapsForDebugging } from "./utils/sourceMapInitializer"
initializeSourceMaps()
exposeSourceMapsForDebugging()

import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import "./index.css"
import AcpApp from "./acp/AcpApp"
import "../node_modules/@vscode/codicons/dist/codicon.css"

createRoot(document.getElementById("root")!).render(
    <StrictMode>
        <AcpApp />
    </StrictMode>,
)
