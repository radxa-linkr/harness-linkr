import { Rpc } from '@opencode/plugin/rpc';

import { panelRpcDefinition } from './rpc-schema.js';

export { PANEL_RPC_ID } from './rpc-schema.js';

export default Rpc.define(panelRpcDefinition());
