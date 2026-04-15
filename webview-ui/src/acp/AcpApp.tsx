import { AcpStateContextProvider } from "./AcpStateContext"
import AcpChatView from "./AcpChatView"
import { TooltipProvider } from "@src/components/ui/tooltip"
import { STANDARD_TOOLTIP_DELAY } from "@src/components/ui/standard-tooltip"
import ErrorBoundary from "@/components/ErrorBoundary"
import TranslationProvider from "@/i18n/TranslationContext"

const AcpApp = () => {
	return (
	<ErrorBoundary>
		<AcpStateContextProvider>
			<TranslationProvider>
				<TooltipProvider delayDuration={STANDARD_TOOLTIP_DELAY}>
					{/* <div className="flex h-full min-h-0 flex-col overflow-hidden bg-vscode-editor-background text-vscode-editor-foreground"> */}
					<AcpChatView />
					{/* </div> */}
				</TooltipProvider>
			</TranslationProvider>
		</AcpStateContextProvider>
	</ErrorBoundary>
	)
}

export default AcpApp


// const AppWithProviders = () => (
// 	<ErrorBoundary>
// 		<ExtensionStateContextProvider>
// 			<TranslationProvider>
// 				<QueryClientProvider client={queryClient}>
// 					<TooltipProvider delayDuration={STANDARD_TOOLTIP_DELAY}>
// 						<App />
// 					</TooltipProvider>
// 				</QueryClientProvider>
// 			</TranslationProvider>
// 		</ExtensionStateContextProvider>
// 	</ErrorBoundary>
// )

// export default AppWithProviders
