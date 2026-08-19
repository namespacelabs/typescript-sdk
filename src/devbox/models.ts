import type { PointerButton, Screenshot as VncScreenshot } from "../vnc/index.js";

export interface OperationOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
}

export type AccessMode = "private" | "workspace";

/**
 * Named machine size, resolved by the backend.
 *
 * `"s"`, `"m"`, `"l"`, and `"xl"` are the sizes known at the time of this SDK
 * release; the backend may accept additional names over time, so any string is
 * allowed when creating a devbox. Updating a devbox or defining a blueprint
 * resolves the size client-side and only supports the known names.
 *
 * macOS devboxes support `"m"` and `"l"` (always resolved client-side).
 */
export type MachineSize = "s" | "m" | "l" | "xl" | (string & {});

export interface InstanceShape {
	vCPUs: number;
	memoryMB: number;
	architecture?: "amd64" | "arm64" | string;
	os?: "linux" | "macos" | string;
}

export interface NetworkPolicy {
	allowedDomains: string[];
	advisory?: boolean;
}

export interface DevboxInfo {
	id: string;
	name: string;
	/**
	 * Runtime state as of the call that produced this snapshot.
	 *
	 * Calls that resolve runtime state (`get`, `refresh`, `start`, `stop`)
	 * report `"running"` or `"stopped"`. `list` is intentionally cheap and does
	 * not resolve runtime state, so listed devboxes report `"unknown"`; call
	 * `refresh()` on a handle for an authoritative answer.
	 */
	state: "running" | "stopped" | "unknown";
	instanceId?: string;
	image: string;
	imageName?: string;
	blueprint?: { id: string; name: string };
	size?: MachineSize;
	shape?: InstanceShape;
	site?: string;
	creator?: string;
	createdAt?: Date;
	lastUsedAt?: Date;
	workspaceDir?: string;
	defaultDir?: string;
	user?: string;
	shell?: string;
	volumeSizeGB?: number;
	purpose?: string;
	ephemeral: boolean;
}

interface CreateDevboxInputBase {
	name: string;
	site?: string;
	purpose?: string;
	access?: AccessMode;
	start?: boolean;
}

export type CreateDevboxInput = CreateDevboxInputBase & ({
	blueprint: string;
	os?: never;
	image?: never;
	size?: never;
	volumeSizeGB?: never;
	repository?: never;
	environment?: never;
	ephemeral?: never;
	privileged?: never;
	features?: never;
	networkPolicy?: never;
} | {
	blueprint?: never;
	/**
	 * Operating system for the devbox. Defaults to `"linux"`.
	 *
	 * macOS devboxes run on Apple Silicon (arm64) and boot a Namespace-managed
	 * macOS base image; `image` cannot be combined with `os: "macos"`. Sizes
	 * `"m"` (6 vCPUs, 14 GB) and `"l"` (12 vCPUs, 28 GB) are supported, and the
	 * size defaults to `"m"` when unset.
	 */
	os?: "linux" | "macos";
	image?: string;
	size?: MachineSize;
	volumeSizeGB?: number;
	repository?: string;
	environment?: Record<string, string>;
	ephemeral?: boolean | { stoppedRetentionMs?: number };
	privileged?: boolean;
	features?: string[];
	networkPolicy?: NetworkPolicy;
});

export interface UpdateDevboxInput {
	size?: MachineSize;
	volumeSizeGB?: number;
	busyTimeoutMs?: number;
	privileged?: boolean;
	networkPolicy?: NetworkPolicy;
}

export interface ListDevboxesOptions extends OperationOptions {
	cursor?: string;
	limit?: number;
	orderBy?: "created" | "last-used";
	ephemeral?: boolean;
}

export interface Page<T> {
	items: T[];
	nextCursor?: string;
}

export interface ExecOptions extends OperationOptions {
	cwd?: string;
	env?: Record<string, string>;
	stdin?: string | Uint8Array;
	onStdout?: (data: Uint8Array) => void;
	onStderr?: (data: Uint8Array) => void;
}

export interface ShellOptions extends ExecOptions {
	shell?: string;
}

export interface ExecResult {
	exitCode: number | null;
	signal: string | null;
	/** Agent-reported failure detail (e.g. "command not found") when the command could not run or exited non-zero. */
	error?: string;
	stdout: string;
	stderr: string;
}

export interface TerminalOpenOptions extends OperationOptions {
	columns?: number;
	rows?: number;
	term?: string;
	env?: Record<string, string>;
}

export interface TerminalSession {
	/** Send input to the terminal. */
	write(data: string | Uint8Array): void;
	/** Resize the remote pseudo-terminal. */
	resize(columns: number, rows: number): void;
	/** Close the session locally. `wait()` then resolves with null exit code and signal. */
	close(): void;
	/** Subscribe to terminal output. Returns an unsubscribe function. */
	onData(listener: (data: Uint8Array) => void): () => void;
	/** Subscribe to session end. Returns an unsubscribe function. */
	onExit(listener: (exitCode: number | null, signal: string | null) => void): () => void;
	/** Subscribe to transport errors. Returns an unsubscribe function. */
	onError(listener: (error: Error) => void): () => void;
	/**
	 * Resolves when the terminal session ends, with the exit code and signal
	 * reported by the remote side (either may be null when unavailable, e.g.
	 * when the session is closed locally).
	 */
	wait(): Promise<{ exitCode: number | null; signal: string | null }>;
}

export type MouseButton = PointerButton;

export interface ClickOptions extends OperationOptions {
	/** Mouse button to click. Defaults to `"left"`. */
	button?: MouseButton;
}

/** A captured screen image; see `Screenshot` in `@namespacelabs/sdk/vnc`. */
export type Screenshot = VncScreenshot;

/**
 * Screen access to a devbox display, backed by VNC.
 *
 * Only devboxes with a graphical display — macOS devboxes — expose one;
 * methods reject with `DevboxDisplayUnavailableError` for devboxes without a
 * display. All methods are connection-backed: calling them on a stopped
 * devbox activates it first.
 */
export interface DevboxDisplay {
	/** Capture the full screen as a PNG. */
	screenshot(options?: OperationOptions): Promise<Screenshot>;
	/**
	 * Click at screen coordinates (origin top-left, in framebuffer pixels):
	 * the pointer moves to `(x, y)`, presses, and releases. Rejects with
	 * `RangeError` when the position is outside the screen.
	 */
	click(x: number, y: number, options?: ClickOptions): Promise<void>;
}

export interface TransferOptions extends OperationOptions {
	onProgress?: (transferredBytes: number, totalBytes: number) => void;
}

export interface WriteFileOptions extends OperationOptions {
	mode?: number;
}

export interface CopyOptions extends OperationOptions {
	recursive?: boolean;
}

export interface MkdirOptions extends OperationOptions {
	/** Create parent directories as needed and ignore an existing directory. */
	recursive?: boolean;
	mode?: number;
}

export interface RemoveOptions extends OperationOptions {
	/** Remove directories and their contents recursively. */
	recursive?: boolean;
}

export interface DirEntry {
	name: string;
	type: "file" | "directory" | "symlink" | "other";
}

/**
 * Remote filesystem access to a devbox.
 *
 * All methods are connection-backed: calling them on a stopped devbox
 * activates it first.
 */
export interface DevboxFileSystem {
	/** Upload one local file to the devbox. */
	upload(localPath: string, remotePath: string, options?: TransferOptions): Promise<void>;
	/** Download one remote file to the local filesystem. */
	download(remotePath: string, localPath: string, options?: TransferOptions): Promise<void>;
	/** Copy a file or directory within the devbox. */
	copy(sourcePath: string, destinationPath: string, options?: CopyOptions): Promise<void>;
	/** Read a remote file's contents into memory. */
	readFile(remotePath: string, options?: OperationOptions): Promise<Uint8Array>;
	/** Write data to a remote file, creating or truncating it. */
	writeFile(remotePath: string, data: string | Uint8Array, options?: WriteFileOptions): Promise<void>;
	/** Whether a file or directory exists at the given path. */
	exists(remotePath: string, options?: OperationOptions): Promise<boolean>;
	/** Rename (move) a file or directory within the devbox. */
	rename(oldPath: string, newPath: string, options?: OperationOptions): Promise<void>;
	/** Create a directory. */
	mkdir(remotePath: string, options?: MkdirOptions): Promise<void>;
	/** Remove a file or (with `recursive`) a directory tree. */
	remove(remotePath: string, options?: RemoveOptions): Promise<void>;
	/** List directory entries (excluding `.` and `..`). */
	readdir(remotePath: string, options?: OperationOptions): Promise<DirEntry[]>;
}

export interface Devbox {
	readonly id: string;
	readonly name: string;
	readonly info: Readonly<DevboxInfo>;
	/**
	 * Remote filesystem access. Connection-backed: using it on a stopped
	 * devbox activates it first.
	 */
	readonly fs: DevboxFileSystem;
	/**
	 * Interactive terminal sessions. Connection-backed: opening a terminal on
	 * a stopped devbox activates it first.
	 */
	readonly terminal: {
		/** Open an interactive terminal session on the devbox. */
		open(options?: TerminalOpenOptions): Promise<TerminalSession>;
	};
	/**
	 * Screen access (screenshots and clicks) for devboxes with a display,
	 * such as macOS devboxes. Methods reject with
	 * `DevboxDisplayUnavailableError` when the devbox has no display.
	 * Connection-backed: using it on a stopped devbox activates it first.
	 */
	readonly display: DevboxDisplay;
	/**
	 * Run a command on the devbox and collect its output.
	 *
	 * A non-zero exit code does not reject: inspect `ExecResult.exitCode`.
	 * The returned promise rejects only for transport-level failures,
	 * timeouts, or aborts. Connection-backed: running a command on a stopped
	 * devbox activates it first. The devbox agent retains the command and its
	 * output for later inspection (`devbox logs`).
	 */
	exec(argv: readonly string[], options?: ExecOptions): Promise<ExecResult>;
	/**
	 * Run a script through the devbox shell and collect its output.
	 *
	 * A non-zero exit code does not reject: inspect `ExecResult.exitCode`.
	 * Connection-backed: running a script on a stopped devbox activates it
	 * first.
	 */
	shell(script: string, options?: ShellOptions): Promise<ExecResult>;
	/** Start the devbox and wait for it to become ready. Updates `info`. */
	start(options?: OperationOptions): Promise<this>;
	/** Stop the devbox and drop any cached connection to it. Updates `info`. */
	stop(options?: OperationOptions): Promise<this>;
	/** Delete the devbox. The handle must not be used afterwards. */
	delete(options?: OperationOptions): Promise<void>;
	/** Re-fetch the devbox, including its authoritative runtime state. Updates `info`. */
	refresh(options?: OperationOptions): Promise<this>;
	/**
	 * Update devbox settings (size, volume, busy timeout, privileged,
	 * network policy). Machine size is resolved client-side, so only the
	 * known size names are supported here. Updates `info`.
	 */
	update(input: UpdateDevboxInput, options?: OperationOptions): Promise<this>;
}

export interface DevboxResource {
	/**
	 * Create a devbox from an image or a blueprint.
	 *
	 * Starts the devbox by default; pass `start: false` to create it stopped.
	 * `site` defaults to `"iad"`.
	 */
	create(input: CreateDevboxInput, options?: OperationOptions): Promise<Devbox>;
	/** Fetch a devbox by id or name, including its authoritative runtime state. */
	get(ref: string, options?: OperationOptions): Promise<Devbox>;
	/**
	 * List devboxes, one page at a time.
	 *
	 * Listing is intentionally cheap: it does not resolve per-devbox runtime
	 * state, so returned devboxes report `state: "unknown"` and no
	 * `instanceId`. Call `refresh()` on a handle when the current state
	 * matters.
	 */
	list(options?: ListDevboxesOptions): Promise<Page<Devbox>>;
	/**
	 * Iterate all devboxes across pages. Same cheap-list semantics as
	 * `list()`.
	 */
	iterate(options?: Omit<ListDevboxesOptions, "cursor">): AsyncIterableIterator<Devbox>;
	/**
	 * Start a devbox by id or name and wait for it to become ready.
	 * Convenience for `get()` followed by `Devbox.start()`.
	 */
	start(ref: string, options?: OperationOptions): Promise<Devbox>;
	/**
	 * Stop a devbox by id or name. Convenience for `get()` followed by
	 * `Devbox.stop()`.
	 */
	stop(ref: string, options?: OperationOptions): Promise<Devbox>;
	/** Delete a devbox by id or name. */
	delete(ref: string, options?: OperationOptions): Promise<void>;
}

export interface BlueprintCommand {
	command: string;
	args?: string[];
}

export interface BlueprintScript {
	script: string;
}

export type BlueprintOperation = BlueprintCommand | BlueprintScript;

export interface BlueprintSession {
	name: string;
	command: string;
	emoji?: string;
}

export interface BlueprintDefinition {
	image: string;
	size?: MachineSize;
	site?: string;
	description?: string;
	/** Who can use the blueprint. Defaults to "private". */
	access?: AccessMode;
	environment?: Record<string, string>;
	volumeSizeGB?: number;
	ephemeral?: boolean | { stoppedRetentionMs?: number };
	features?: string[];
	networkPolicy?: NetworkPolicy;
	busyTimeoutMs?: number;
}

export interface ImageMetadata {
	workspaceDir?: string;
	shell?: string;
	user?: string;
	privileged?: boolean;
	environment?: Record<string, string>;
	onCreate?: BlueprintOperation[];
	onStart?: BlueprintOperation[];
	sessions?: BlueprintSession[];
	includeInPath?: string[];
}

export interface Blueprint {
	id: string;
	name: string;
	version: bigint;
	createdAt?: Date;
	updatedAt?: Date;
	definition: BlueprintDefinition;
}

export interface ListBlueprintsOptions extends OperationOptions {
	cursor?: string;
	limit?: number;
	orderBy?: "created" | "updated";
}

export interface BlueprintResource {
	/**
	 * Create a named blueprint. Access defaults to `"private"`; machine size
	 * is resolved client-side, so only the known size names are supported.
	 */
	create(name: string, definition: BlueprintDefinition, options?: OperationOptions): Promise<Blueprint>;
	/** Fetch a blueprint by name. */
	get(name: string, options?: OperationOptions): Promise<Blueprint>;
	/** List blueprints, one page at a time. */
	list(options?: ListBlueprintsOptions): Promise<Page<Blueprint>>;
	/** Iterate all blueprints across pages. */
	iterate(options?: Omit<ListBlueprintsOptions, "cursor">): AsyncIterableIterator<Blueprint>;
	/**
	 * Replace a blueprint's definition.
	 *
	 * The definition passed here replaces the stored one wholesale
	 * (last-write-wins). There is no compare-and-swap: a concurrent update
	 * between your read and this call is silently overwritten.
	 */
	update(name: string, definition: BlueprintDefinition, options?: OperationOptions): Promise<Blueprint>;
	/** Delete a blueprint by name. */
	delete(name: string, options?: OperationOptions): Promise<void>;
}

export interface Image {
	id: string;
	name: string;
	repository: string;
	digest: string;
	originalDigest?: string;
	ref: string;
	version: bigint;
	description?: string;
	createdAt?: Date;
	expiresAt?: Date;
	managed: boolean;
}

export interface RegisterImageInput {
	ref: string;
	name: string;
	description?: string;
	metadata?: ImageMetadata;
}

export type ImageSelector = string | { id: string } | { name: string } | {
	digest: string;
	version?: bigint;
};

export interface ListImagesOptions extends OperationOptions {
	cursor?: string;
	includeBuiltin?: boolean;
}

export interface ImageInspection {
	user?: string;
	environment: Record<string, string>;
	optimizedKinds: string[];
	optimizedSites: string[];
	version: bigint;
	versionCreatedAt?: Date;
}

export interface OptimizeImageOptions extends OperationOptions {
	site?: string;
	onProgress?: (status: "preparing" | "starting" | "baking") => void;
}

export interface ImageResource {
	/**
	 * Register an image ref under a name, making it available for devboxes
	 * and blueprints. Metadata fields left unset are derived from the image
	 * by the server.
	 */
	register(input: RegisterImageInput, options?: OperationOptions): Promise<Image>;
	/** Fetch a registered image by ref, id, name, or digest. */
	get(selector: ImageSelector, options?: OperationOptions): Promise<Image>;
	/**
	 * List registered images, one page at a time. Built-in images are
	 * excluded unless `includeBuiltin` is set.
	 */
	list(options?: ListImagesOptions): Promise<Page<Image>>;
	/** Iterate all images across pages. */
	iterate(options?: Omit<ListImagesOptions, "cursor">): AsyncIterableIterator<Image>;
	/** Inspect an image version: user, environment, and optimization state. */
	inspect(selector: ImageSelector, options?: OperationOptions): Promise<ImageInspection>;
	/**
	 * Optimize an image for fast devbox startup at a site (defaults to
	 * `"iad"`). This is expensive and can take minutes; `onProgress` reports
	 * coarse phases. Resolves when optimization completes, rejects with
	 * `ImageOptimizationError` on failure.
	 */
	optimize(selector: ImageSelector, options?: OptimizeImageOptions): Promise<void>;
	/** Delete a registered image version. */
	delete(selector: ImageSelector, options?: OperationOptions): Promise<void>;
}
