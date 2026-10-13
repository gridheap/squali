import Foundation
import AppKit
import AVFoundation
let source=URL(fileURLWithPath:CommandLine.arguments[1]);let root=URL(fileURLWithPath:CommandLine.arguments[2],isDirectory:true)
let asset=AVURLAsset(url:source)
let generator=AVAssetImageGenerator(asset:asset);generator.appliesPreferredTrackTransform=true
for t in [0,80,160,250,355] {
 let image=try generator.copyCGImage(at:CMTime(value:Int64(t),timescale:1),actualTime:nil)
 let bitmap=NSBitmapImageRep(cgImage:image)
 try bitmap.representation(using:.png,properties:[:])!.write(to:root.appendingPathComponent("verify-\(t).png"))
}
let attrs=try FileManager.default.attributesOfItem(atPath:source.path)
let report:[String:Any]=["command":"swift work/demo/render.swift work/demo outputs/squali-demo.mp4","durationSeconds":CMTimeGetSeconds(asset.duration),"videoTracks":asset.tracks(withMediaType:.video).count,"audioTracks":asset.tracks(withMediaType:.audio).count,"bytes":attrs[.size]!,"format":"Edited narrated walkthrough using captured local application screens"]
try JSONSerialization.data(withJSONObject:report,options:.prettyPrinted).write(to:root.appendingPathComponent("verification.json"));print(String(data:try JSONSerialization.data(withJSONObject:report),encoding:.utf8)!)
