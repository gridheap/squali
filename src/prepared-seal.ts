import {Problem,type Sql,type Commit,type SourceDelta} from './types.ts';
import {resolveDerivedBatch} from './derived-data.ts';
import {deriveGraphNode} from './graph.ts';
import {derivePathValue} from './path-index.ts';
import {sourceManifest} from './source-manifest.ts';
import {timed} from './timing.ts';

/** Common online case: read its complete dependency closure once, then atomically
 * persist canonical identity and both derived results in one statement. Missing
 * indexes, merge commits and replays use the general recursive sealing path.
 * Called only after the source writer verifies and durably admits every object. */
export async function sealPreparedSource(sql:Sql,project:string,commit:Commit,raw:Uint8Array,delta:SourceDelta[]){
 if(commit.parents.length>1||delta.length>256)return false;
 const parent=commit.parents[0]??null,blobIds=[...new Set(delta.filter(f=>f.mode&&f.mode!=='160000').map(f=>f.gitOid!))];
 const [input]=await timed('seal_read',()=>sql`WITH RECURSIVE chain AS (
  SELECT oid,tree,generation,first_depth,linear_span,tree_span,jumps,0 AS level
  FROM weave_commit_graph WHERE project=${project} AND version=1 AND oid=${parent} AND generation IS NOT NULL
  UNION ALL
  SELECT g.oid,g.tree,g.generation,g.first_depth,g.linear_span,g.tree_span,g.jumps,c.level+1
  FROM chain c JOIN weave_commit_graph g ON g.project=${project} AND g.version=1 AND g.oid=c.jumps[c.level+1]
  WHERE c.level<31 AND g.generation IS NOT NULL
 ) SELECT
  (SELECT id FROM weave_changesets WHERE project=${project} AND git_oid=${commit.oid}) AS existing,
  (SELECT id FROM weave_changesets WHERE project=${project} AND git_oid=${parent}) AS parent_id,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('oid',oid,'tree',tree,'generation',generation,'depth',first_depth,'span',linear_span,'treeSpan',tree_span) ORDER BY level) FROM chain),'[]') AS chain,
  (SELECT value FROM weave_derived WHERE project=${project} AND kind='source-paths:v1' AND key=${parent}) AS parent_path,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('oid',o.oid,'blob',o.blob)) FROM weave_source_objects o JOIN weave_source_blobs b ON b.hash=o.blob
   WHERE o.project=${project} AND o.kind='blob' AND o.oid=ANY(${blobIds}) AND b.state='ready'),'[]') AS blobs`);
 if(input.existing)return false;
 const chain=input.chain as ReturnType<typeof deriveGraphNode>[];
 if(parent&&(!input.parent_id||!chain.length||!input.parent_path||input.parent_path.depth!==chain[0].depth||chain.length!==Math.floor(Math.log2(chain[0].depth+1))+1))return false;
 if(input.blobs.length!==blobIds.length)throw new Problem(409,'source_incomplete','Changed blob is missing');
 const blobs=new Map<string,string>(input.blobs.map((b:any)=>[b.oid,b.blob]));
 const files=delta.map(f=>({path:f.path,mode:f.mode,...(f.rawMode?{rawMode:f.rawMode}:{}),blob:f.mode&&f.mode!=='160000'?blobs.get(f.gitOid!)!:null,gitOid:f.gitOid}));
 const manifest=sourceManifest(commit,raw,parent?[input.parent_id]:[],files);
 // Retain the shared versioned resolver and calculations. Here its dependency
 // reads are served by the immutable snapshot, and saves form one atomic batch.
 const graph=(await timed('graph',()=>resolveDerivedBatch<ReturnType<typeof deriveGraphNode>,Commit>({kind:'commit-graph',version:1,
  async read(keys){return new Map(parent&&keys.includes(parent)?[[parent,chain[0]]]:[]);},
  async load(){return new Map([[commit.oid,{key:commit.oid,parents:commit.parents,input:commit}]]);},
  async compute(nodes,resolved){return new Map(nodes.map(node=>[node.key,{...deriveGraphNode(node.input,node.parents.map(id=>resolved.get(id)!)),jumps:chain.map(n=>n.oid)}]));},
  async save(){}
 },[commit.oid]))).values[0];
 const paths=files.map(f=>f.path);
 const path=(await timed('paths',()=>resolveDerivedBatch<ReturnType<typeof derivePathValue>,string[]>({kind:'source-paths',version:1,
  async read(keys){return new Map(parent&&keys.includes(parent)?[[parent,input.parent_path]]:[]);},
  async load(){return new Map([[commit.oid,{key:commit.oid,parents:commit.parents,input:paths}]]);},
  async compute(nodes,resolved){return new Map(nodes.map(node=>[node.key,derivePathValue(node.key,parent,parent?resolved.get(parent):undefined,node.input)]));},
  async save(){}
 },[commit.oid]))).values[0];
 const {paths:_,...marker}=path;
 await timed('seal_write',()=>sql`WITH canonical AS (
  INSERT INTO weave_changesets(project,id,git_oid,parents,files,metadata)
  VALUES(${project},${manifest.id},${commit.oid},${manifest.parents},${sql.json(manifest.files)},${sql.json(manifest.metadata)}) ON CONFLICT DO NOTHING
 ), graph AS (
  INSERT INTO weave_commit_graph(project,version,oid,tree,parents,message,generation,first_depth,linear_span,tree_span,jumps)
  VALUES(${project},1,${commit.oid},${commit.tree},${commit.parents},${commit.message},${graph.generation},${graph.depth},${graph.span},${graph.treeSpan},${graph.jumps})
  ON CONFLICT(project,version,oid) DO UPDATE SET generation=EXCLUDED.generation,first_depth=EXCLUDED.first_depth,linear_span=EXCLUDED.linear_span,tree_span=EXCLUDED.tree_span,jumps=EXCLUDED.jumps WHERE weave_commit_graph.generation IS NULL
 ), paths AS (
  INSERT INTO weave_source_paths(project,version,path,git_oid) SELECT ${project},1,path,${commit.oid} FROM unnest(${paths}::text[]) AS path ON CONFLICT DO NOTHING
 ) INSERT INTO weave_derived(project,kind,key,value) VALUES(${project},'source-paths:v1',${commit.oid},${sql.json(marker)}) ON CONFLICT DO NOTHING`);
 return true;
}
