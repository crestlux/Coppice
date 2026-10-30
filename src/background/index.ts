import { initializeExtension } from "./init";
import { registerEventHandlers } from "./events";

registerEventHandlers();
void initializeExtension({ runStartupTasks: false });
