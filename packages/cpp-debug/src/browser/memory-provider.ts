/********************************************************************************
 * Copyright (C) 2019 Ericsson and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the Eclipse Public License v. 2.0 which is available at
 * http://www.eclipse.org/legal/epl-2.0.
 *
 * This Source Code may also be made available under the following Secondary
 * Licenses when the conditions for such availability set forth in the Eclipse
 * Public License v. 2.0 are satisfied: GNU General Public License, version 2
 * with the GNU Classpath Exception which is available at
 * https://www.gnu.org/software/classpath/license.html.
 *
 * SPDX-License-Identifier: EPL-2.0 OR GPL-2.0 WITH Classpath-exception-2.0
 ********************************************************************************/

import { injectable, inject } from "inversify";
import { DebugSessionManager } from '@theia/debug/lib/browser/debug-session-manager';
import { DebugVariable } from "@theia/debug/lib/browser/console/debug-console-items";
import * as Long from 'long';
import { hexStrToUnsignedLong } from "../common/util";

export interface MemoryReadResult {
    bytes: Uint8Array,
    address: Long,
}

export const MemoryProvider = Symbol('MemoryProvider');
export interface MemoryProvider {
    /**
     * Read `number` bytes of memory at address `location`, which can be
     * any expression evaluating to an address.
     */
    readMemory(location: string, length: number): Promise<MemoryReadResult>;
    getLocals(): Promise<VariableRange[]>;
}

export interface VariableRange {
    name: string;
    address: Long;
    pastTheEndAddress: Long;
}

/**
 * Convert an hex-encoded string of bytes to the Uint8Array equivalent.
 */
function hex2bytes(hex: string): Uint8Array {
    const arr: Uint8Array = new Uint8Array(hex.length / 2);

    for (let i = 0; i < hex.length / 2; i++) {
        const hexByte = hex.slice(i * 2, i * 2 + 2);
        const byte = parseInt(hexByte, 16);
        arr[i] = byte;
    }

    return arr;
}

/**
 * Read memory through the current debug session, using the cdt-gdb-adapter
 * extension to read memory.
 */
@injectable()
export class MemoryProviderImpl implements MemoryProvider {
    @inject(DebugSessionManager)
    protected readonly debugSessionManager!: DebugSessionManager;

    async readMemory(location: string, length: number): Promise<MemoryReadResult> {
        const session = this.debugSessionManager.currentSession;
        if (session === undefined) {
            throw new Error('No active debug session.');
        }

        const result = await session.sendCustomRequest('cdt-gdb-adapter/Memory', {
            address: location,
            length: length,
        });

        const bytes = hex2bytes(result.body.data);
        const address = hexStrToUnsignedLong(result.body.address);

        return {
            bytes: bytes,
            address: address,
        };
    }

    async getLocals(): Promise<VariableRange[]> {
        const session = this.debugSessionManager.currentSession;
        if (session === undefined) {
            throw new Error('No active debug session.');
        }

        const frame = session.currentFrame;
        if (frame === undefined) {
            throw new Error('No active stack frame.');
        }

        const ranges: VariableRange[] = [];

        const scopes = await frame.getScopes();
        for (const scope of scopes) {
            const variables = await scope.getElements();
            for (const v of variables) {
                if (v instanceof DebugVariable) {
                    const addrExp = `&${v.name}`;
                    const sizeExp = `sizeof(${v.name})`;
                    const addrResp = await session.sendRequest('evaluate', {
                        expression: addrExp,
                        context: 'watch',
                        frameId: frame.raw.id,
                    });
                    const sizeResp = await session.sendRequest('evaluate', {
                        expression: sizeExp,
                        context: 'watch',
                        frameId: frame.raw.id,
                    });

                    // Make sure the address is in the format we expect.
                    if (!/^0x[0-9a-fA-F]+$/.test(addrResp.body.result)) {
                        continue;
                    }

                    if (!/^[0-9]+$/.test(sizeResp.body.result)) {
                        continue;
                    }

                    const size = parseInt(sizeResp.body.result);
                    const address = hexStrToUnsignedLong(addrResp.body.result);
                    const pastTheEndAddress = address.add(size);

                    ranges.push({
                        name: v.name,
                        address: address,
                        pastTheEndAddress: pastTheEndAddress,
                    });
                }
            }
        }

        return ranges;
    }
}
