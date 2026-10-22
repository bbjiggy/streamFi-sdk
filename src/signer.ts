import { Keypair, Transaction } from '@stellar/stellar-sdk';
import { SignatureTimeoutError } from './errors.js';

/** Default time (ms) to wait for a wallet/signer to return a signature. */
export const DEFAULT_SIGNATURE_TIMEOUT_MS = 120_000;

export interface SignerOptions {
  /**
   * Max time (ms) to wait for a signature before rejecting with
   * {@link SignatureTimeoutError}. Default 120000. Set to `0` or `Infinity`
   * to wait indefinitely.
   */
  signatureTimeoutMs?: number;
}

/**
 * Races `pending` against a timer so a wallet popup that is never answered
 * cannot leave the caller hanging forever.
 */
export function withSignatureTimeout<T>(
  pending: Promise<T> | T,
  timeoutMs: number = DEFAULT_SIGNATURE_TIMEOUT_MS,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.resolve(pending);
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new SignatureTimeoutError(timeoutMs)), timeoutMs);
    Promise.resolve(pending).then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

export interface Signer {
  /**
   * Sign `tx`. An implementation may either mutate `tx` in place and return
   * `void`, or return a new signed `Transaction` (the immutable pattern).
   * `StreamsModule._signTx` uses the return value when it is a `Transaction`
   * and falls back to the passed `tx` otherwise.
   */
  sign(tx: Transaction): Transaction | void | Promise<Transaction | void>;
  publicKey(): string;
}

export class KeypairSigner implements Signer {
  constructor(private readonly keypair: Keypair) {}
  sign(tx: Transaction): void {
    tx.sign(this.keypair);
  }
  publicKey(): string {
    return this.keypair.publicKey();
  }
}

// ── Ledger hardware wallet error codes ──────────────────────────────────

export enum LedgerErrorType {
  /** The user rejected the signing request on the Ledger device. */
  UserRejected = 'USER_REJECTED',
  /** The Ledger device is locked and requires a PIN unlock. */
  DeviceLocked = 'DEVICE_LOCKED',
  /** The Ledger Stellar app is not open on the device. */
  AppNotOpen = 'APP_NOT_OPEN',
  /** The Ledger device was disconnected during the operation. */
  DeviceDisconnected = 'DEVICE_DISCONNECTED',
  /** A transport-level error occurred (USB/Bluetooth). */
  TransportError = 'TRANSPORT_ERROR',
  /** The Ledger returned an invalid response or malformed data. */
  InvalidResponse = 'INVALID_RESPONSE',
  /** An unknown Ledger error code was received. */
  Unknown = 'UNKNOWN',
}

/** Map of Ledger status words to human-readable error types and messages. */
const LEDGER_ERROR_MAP: Record<number, { type: LedgerErrorType; message: string }> = {
  0x6982: { type: LedgerErrorType.UserRejected, message: 'Transaction rejected by the user on the Ledger device.' },
  0x6984: { type: LedgerErrorType.InvalidResponse, message: 'Invalid data received from the Ledger device.' },
  0x6985: { type: LedgerErrorType.AppNotOpen, message: 'Conditions not satisfied — ensure the Ledger Stellar app is open.' },
  0x6A80: { type: LedgerErrorType.InvalidResponse, message: 'Invalid parameters sent to the Ledger device.' },
  0x6B00: { type: LedgerErrorType.InvalidResponse, message: 'Invalid instruction sent to the Ledger device.' },
  0x6700: { type: LedgerErrorType.InvalidResponse, message: 'Wrong data length in Ledger response.' },
  0x6F00: { type: LedgerErrorType.TransportError, message: 'Generic Ledger transport error.' },
  0x9000: { type: LedgerErrorType.UserRejected, message: 'Ledger operation completed successfully.' },
};

/**
 * Normalizes a raw Ledger error code (status word) into a typed
 * `LedgerErrorType` and a human-readable message.
 *
 * @param statusCode The Ledger status word returned by the device.
 * @returns An object containing the error type and a human-readable message.
 */
export function normalizeLedgerError(statusCode: number): { type: LedgerErrorType; message: string } {
  return LEDGER_ERROR_MAP[statusCode] ?? { type: LedgerErrorType.Unknown, message: `Unknown Ledger error code: 0x${statusCode.toString(16).toUpperCase()}` };
}

/**
 * Checks whether an error originated from a Ledger hardware wallet
 * and, if so, returns the normalized `LedgerErrorType` and message.
 *
 * Returns `null` when the error is not a Ledger error.
 */
export function classifyLedgerError(error: unknown): { type: LedgerErrorType; message: string } | null {
  if (!(error instanceof Error)) return null;
  const match = error.message.match(/Ledger status word: 0x([0-9A-Fa-f]{4})/);
  if (!match?.[1]) return null;
  const statusCode = parseInt(match[1], 16);
  return normalizeLedgerError(statusCode);
}

/**
 * Minimal contract a Ledger device adapter must satisfy, so the signer can be
 * unit-tested with a mock and wired to `@ledgerhq` (or any transport) in
 * production without a hard dependency on the hardware libraries (#912).
 */
export interface LedgerDevice {
  /** Resolve the Stellar public key for `path`. */
  getPublicKey(path: string): Promise<{ publicKey: string }>;
  /** Sign `txXdr`, returning the reconstructed signed transaction XDR. */
  signTransaction(path: string, txXdr: string): Promise<{ signature: Uint8Array; signedTxXdr: string }>;
}

/** A Ledger hardware wallet signer that implements the `Signer` interface (#912). */
export class LedgerSigner implements Signer {
  private readonly appName: string;
  private readonly path: string;
  private readonly device: LedgerDevice | undefined;
  private cachedPublicKey: string | undefined;

  constructor(options?: { appName?: string; path?: string; device?: LedgerDevice; publicKey?: string }) {
    this.appName = options?.appName ?? 'Stellar';
    this.path = options?.path ?? "44'/148'/0'/0/0";
    this.device = options?.device;
    this.cachedPublicKey = options?.publicKey;
  }

  /**
   * Synchronous accessor required by the `Signer` interface. Ledger key
   * resolution is asynchronous, so the key must be supplied up front (e.g.
   * derived offline) or fetched first via {@link getPublicKey}; before that,
   * this throws a {@link LedgerHardwareError}.
   */
  publicKey(): string {
    if (!this.cachedPublicKey) {
      throw new LedgerHardwareError(
        LedgerErrorType.DeviceDisconnected,
        'Ledger public key not yet resolved — pass publicKey in the constructor or call getPublicKey() first.',
      );
    }
    return this.cachedPublicKey;
  }

  /** Fetch and cache the device public key for {@link publicKey}. */
  async getPublicKey(): Promise<string> {
    if (this.cachedPublicKey) return this.cachedPublicKey;
    const device = await this.resolveDevice();
    const { publicKey } = await device.getPublicKey(this.path);
    this.cachedPublicKey = publicKey;
    return publicKey;
  }

  /** Sign `tx` on the device and return the reconstructed transaction. */
  async sign(tx: Transaction): Promise<Transaction> {
    const device = await this.resolveDevice();
    const { signedTxXdr } = await device.signTransaction(this.path, tx.toXDR());
    const passphrase = (tx as { networkPassphrase?: string }).networkPassphrase ?? '';
    return new Transaction(signedTxXdr, passphrase);
  }

  /**
   * Use the injected device when present; otherwise lazily wire the real
   * `@ledgerhq` app over a WebUSB transport. The libraries are only imported
   * here (not at module load) so the SDK builds and tests without them
   * installed — production callers typically inject their own device.
   */
  private async resolveDevice(): Promise<LedgerDevice> {
    if (this.device) return this.device;
    try {
      // The hardware libraries are imported lazily (not at module load) so the
      // SDK builds and tests without them installed. Production callers typically
      // inject their own device instead. The specifiers are kept in variables so
      // bundler/transform import-analysis cannot try to statically resolve these
      // optional deps (which may be absent from the dependency tree).
      const ledgerAppModule = '@ledgerhq/hw-app-str';
      const ledgerTransportModule = '@ledgerhq/hw-transport-webusb';
      const hwApp: any = await import(ledgerAppModule);
      const transportMod: any = await import(ledgerTransportModule);
      const TransportWebUSB = transportMod.default ?? transportMod;
      const t: unknown = await TransportWebUSB.create();
      const app = new hwApp.default(t);
      return {
        getPublicKey: (path: string) => app.getPublicKey(path),
        signTransaction: (path: string, txXdr: string) => app.signTransaction(path, txXdr),
      };
    } catch {
      throw new LedgerHardwareError(
        LedgerErrorType.TransportError,
        'Ledger device not available: inject a LedgerDevice or install @ledgerhq/hw-app-str and @ledgerhq/hw-transport-webusb.',
      );
    }
  }
}

/** Error thrown when a Ledger hardware wallet operation fails. */
export class LedgerHardwareError extends Error {
  readonly type: LedgerErrorType;

  constructor(type: LedgerErrorType, message: string) {
    super(message);
    this.name = 'LedgerHardwareError';
    this.type = type;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
