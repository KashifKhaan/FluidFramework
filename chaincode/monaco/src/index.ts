import { IChaincode, IPlatform, IRuntime } from "@prague/runtime-definitions";
import { SharedString } from "@prague/shared-string";
import { Deferred } from "@prague/utils";
import { EventEmitter } from "events";
import * as monaco from "monaco-editor";
import { Chaincode } from "./chaincode";
import { Document } from "./document";

// tslint:disable
(self as any).MonacoEnvironment = {
	getWorkerUrl: function (moduleId, label) {
		switch (label) {
			case 'json': return require('blob-url-loader?type=application/javascript!compile-loader?target=worker&emit=false!monaco-editor/esm/vs/language/json/json.worker');
			case 'css': return require('blob-url-loader?type=application/javascript!compile-loader?target=worker&emit=false!monaco-editor/esm/vs/language/css/css.worker');
			case 'html': return require('blob-url-loader?type=application/javascript!compile-loader?target=worker&emit=false!monaco-editor/esm/vs/language/html/html.worker');
			case 'typescript':
			case 'javascript': return require('blob-url-loader?type=application/javascript!compile-loader?target=worker&emit=false!monaco-editor/esm/vs/language/typescript/ts.worker');
			default:
				return require('blob-url-loader?type=application/javascript!compile-loader?target=worker&emit=false!monaco-editor/esm/vs/editor/editor.worker');
		}
	}
};
// tslint:enable

class NotebookRunner extends EventEmitter implements IPlatform {
    private started = new Deferred<void>();
    private mapHost: HTMLElement;

    public async run(runtime: IRuntime, platform: IPlatform) {
        this.start(runtime, platform).then(
            () => {
                this.started.resolve();
            },
            (error) => {
                console.error(error);
                this.started.reject(error);
            });

        return this;
    }

    public async queryInterface<T>(id: string): Promise<any> {
        // Wait for start to complete before resolving interfaces
        await this.started.promise;

        switch (id) {
            default:
                return null;
        }
    }

    private async start(runtime: IRuntime, platform: IPlatform): Promise<void> {
        const doc = await Document.Load(runtime);

        this.mapHost = await platform.queryInterface<HTMLElement>("div");
        if (!this.mapHost) {
            return;
        }

        this.mapHost.style.width = "800px";
        this.mapHost.style.height = "600px";
        this.mapHost.style.border = "1px solid #ccc";

        const root = await doc.getRoot().getView();
        if (!runtime.existing) {
            const codeString = doc.createString();
            codeString.insertText('console.log("Hello, world!");', 0);
            root.set("text", codeString);
        }

        const text = await root.wait<SharedString>("text");
        const codeEditor = monaco.editor.create(
            this.mapHost,
            {
                language: "typescript",
                value: text.getText(),
            });

        let ignoreModelContentChanges = false;
        codeEditor.onDidChangeModelContent((e) => {
            if (ignoreModelContentChanges) {
                return;
            }

            for (const change of e.changes) {
                if (change.text) {
                    if (change.rangeLength === 0) {
                        text.insertText(change.text, change.rangeOffset);
                    } else {
                        text.replaceText(change.text, change.rangeOffset, change.rangeOffset + change.rangeLength);
                    }
                } else {
                    text.removeText(change.rangeOffset, change.rangeOffset + change.rangeLength);
                }
            }

            console.log(e.changes);
        });

        text.on(
            "op",
            (op, local) => {
                if (local) {
                    return;
                }

                try {
                    ignoreModelContentChanges = true;
                    codeEditor.setValue(text.getText());
                } finally {
                    ignoreModelContentChanges = false;
                }
            });
    }
}

export async function instantiate(): Promise<IChaincode> {
    // Instantiate a new runtime per code load. That'll separate handlers, etc...
    const chaincode = new Chaincode(new NotebookRunner());
    return chaincode;
}
