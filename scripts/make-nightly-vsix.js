const { spawnSync } = require("child_process")
const fs = require("fs")
const os = require("os")
const path = require("path")

const repoRoot = path.join(__dirname, "..")
const binDir = path.join(repoRoot, "bin")
const sourcePackagePath = path.join(repoRoot, "src", "package.json")
const nightlyNlsPath = path.join(repoRoot, "apps", "vscode-nightly", "package.nls.nightly.json")

const sourcePackage = JSON.parse(fs.readFileSync(sourcePackagePath, "utf8"))
const nightlyNls = JSON.parse(fs.readFileSync(nightlyNlsPath, "utf8"))
const stableName = sourcePackage.name
const nightlyName = `${stableName}-nightly`
const version = sourcePackage.version
const stableVsix = path.join(binDir, `${stableName}-${version}.vsix`)
const nightlyVsix = path.join(binDir, `${nightlyName}-${version}.vsix`)

const stablePrefix = "costrict"
const nightlyPrefix = "costrict-nightly"

const run = (command, args, options = {}) => {
	const result = spawnSync(command, args, { stdio: "inherit", shell: process.platform === "win32", ...options })
	if (result.status !== 0) {
		process.exit(result.status ?? 1)
	}
}

const cloneJson = (value) => JSON.parse(JSON.stringify(value))

const replaceText = (text) =>
	text
		.replaceAll(stableName, nightlyName)
		.replaceAll(stablePrefix, nightlyPrefix)
		.replaceAll(`${nightlyPrefix}-nightly`, nightlyPrefix)
		.replaceAll(`${sourcePackage.publisher}-nightly`, sourcePackage.publisher)

const replaceJsonDeep = (value) => {
	if (typeof value === "string") {
		return replaceText(value)
	}

	if (Array.isArray(value)) {
		return value.map(replaceJsonDeep)
	}

	if (value && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [replaceText(key), replaceJsonDeep(item)]))
	}

	return value
}

const writeJson = (filePath, value) => {
	fs.writeFileSync(filePath, `${JSON.stringify(value, null, "\t")}\n`)
}

const patchPackageJson = (unpackDir) => {
	const packagePath = path.join(unpackDir, "extension", "package.json")
	const packageJson = replaceJsonDeep(JSON.parse(fs.readFileSync(packagePath, "utf8")))
	packageJson.name = nightlyName
	packageJson.publisher = sourcePackage.publisher
	packageJson.version = version
	packageJson.author = cloneJson(sourcePackage.author)
	packageJson.repository = cloneJson(sourcePackage.repository)
	packageJson.homepage = sourcePackage.homepage
	packageJson.keywords = sourcePackage.keywords
	writeJson(packagePath, packageJson)
}

const patchNls = (unpackDir) => {
	const nlsPath = path.join(unpackDir, "extension", "package.nls.json")
	const nlsJson = JSON.parse(fs.readFileSync(nlsPath, "utf8"))
	writeJson(nlsPath, { ...nlsJson, ...nightlyNls })
}

const patchTextFile = (filePath) => {
	fs.writeFileSync(filePath, replaceText(fs.readFileSync(filePath, "utf8")))
}

const patchVsixManifest = (unpackDir) => {
	const manifestPath = path.join(unpackDir, "extension.vsixmanifest")
	let manifest = fs.readFileSync(manifestPath, "utf8")
	manifest = replaceText(manifest)
	manifest = manifest.replaceAll(`${nightlyName}-ai`, sourcePackage.publisher)
	manifest = manifest.replace(/Publisher="[^"]+"/, `Publisher="${sourcePackage.publisher}"`)
	manifest = manifest.replaceAll(`/${sourcePackage.publisher}-nightly.`, `/${sourcePackage.publisher}.`)
	fs.writeFileSync(manifestPath, manifest)
}

const patchRuntimeBundle = (unpackDir) => {
	const bundlePath = path.join(unpackDir, "extension", "dist", "extension.js")
	let bundle = fs.readFileSync(bundlePath, "utf8")
	bundle = bundle.replace(/name:process\.env\.COSTRICT_PKG_NAME\|\|[^,}]+/, 'name:"zgsm-nightly"')
	bundle = bundle.replace(/name:"zgsm"/, 'name:"zgsm-nightly"')
	bundle = bundle.replace(
		/commandIDPrefix:process\.env\.COSTRICT_PKG_COMMAND_ID_PREFIX\|\|[^,}]+/,
		'commandIDPrefix:"costrict-nightly"',
	)
	bundle = bundle.replace(/commandIDPrefix:"costrict"/, 'commandIDPrefix:"costrict-nightly"')
	fs.writeFileSync(bundlePath, bundle)
}

const main = () => {
	if (!fs.existsSync(stableVsix)) {
		console.error(`Stable VSIX not found: ${stableVsix}`)
		console.error("Run pnpm vsix first.")
		process.exit(1)
	}

	const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "costrict-nightly-vsix-"))

	try {
		run("unzip", ["-q", stableVsix, "-d", workDir])

		patchPackageJson(workDir)
		patchNls(workDir)
		patchVsixManifest(workDir)
		patchRuntimeBundle(workDir)

		fs.rmSync(nightlyVsix, { force: true })
		run("zip", ["-qr", nightlyVsix, "."], { cwd: workDir })
		console.log(`Packaged nightly VSIX: ${nightlyVsix}`)
	} finally {
		fs.rmSync(workDir, { recursive: true, force: true })
	}
}

module.exports = {
	cloneJson,
	patchPackageJson,
	patchRuntimeBundle,
	replaceJsonDeep,
	replaceText,
}

if (require.main === module) {
	main()
}
