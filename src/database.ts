import postgres from 'postgres';

/** Hyperdrive supports prepared statements. Disabling them adds parameter-type
 * discovery messages that its transaction pooling does not reliably support.
 * Keep type discovery at connection setup: this schema uses text[] columns. */
export function connectDatabase(url:string,options:Omit<postgres.Options<{}>,'prepare'|'fetch_types'>={}){
 return postgres(url,{max:1,...options,prepare:true,fetch_types:true});
}
