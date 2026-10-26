import { ChatGptWebAdapterError } from "./adapter-error";

/** Retransmits only one immutable metadata frame. It has no Send/Stop/tool authority. */
export class NativeMetadataAcknowledgement {
  readonly promise: Promise<void>;
  private resolvePromise!: () => void;
  private rejectPromise!: (error: Error) => void;
  private retry?: ReturnType<typeof setInterval>;
  private timeout?: ReturnType<typeof setTimeout>;
  private settled = false;
  private readonly deadlineError = () => new ChatGptWebAdapterError("Original metadata acknowledgement deadline exhausted; execution is retained",{status:503,errorType:"server_error",code:"chatgpt_execution_retained",retryable:false});
  constructor(frame: unknown, write: (frame: unknown) => boolean, private readonly deadlineAt = Date.now() + 10_000, retryMs = 1_000) {
    const serialized=JSON.stringify(frame);
    this.promise=new Promise<void>((resolve,reject)=>{this.resolvePromise=resolve;this.rejectPromise=reject;});
    void this.promise.catch(()=>{});
    const retained=(reason:string)=>new ChatGptWebAdapterError(reason,{status:503,errorType:"server_error",code:"chatgpt_execution_retained",retryable:false});
    const emit=()=>{
      if(this.settled)return;
      if(Date.now()>=deadlineAt){this.reject(retained("Original metadata acknowledgement deadline exhausted; execution is retained"));return;}
      try{if(!write(JSON.parse(serialized)))this.reject(retained("Original metadata acknowledgement transport closed; execution is retained"));}
      catch{this.reject(retained("Original metadata acknowledgement transport failed; execution is retained"));}
    };
    this.retry=setInterval(emit,Math.max(1,retryMs));
    this.timeout=setTimeout(()=>this.reject(retained("Original metadata acknowledgement deadline exhausted; execution is retained")),Math.max(1,deadlineAt-Date.now()));
    emit();
  }
  resolve():boolean{if(this.settled)return false;if(Date.now()>=this.deadlineAt){this.reject(this.deadlineError());return false;}this.settled=true;this.clear();this.resolvePromise();return true;}
  reject(error:Error):void{if(this.settled)return;this.settled=true;this.clear();this.rejectPromise(error);}
  private clear():void{if(this.retry)clearInterval(this.retry);if(this.timeout)clearTimeout(this.timeout);}
}
