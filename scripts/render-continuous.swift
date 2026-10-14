import Foundation
import AppKit
import AVFoundation
import CoreVideo

// Encode every moment of the retained screencast, in order, at five frames/sec.
// Holding the latest raw frame during a static screen is normal video timing.
// No scene boundaries, edits or replacement screenshots enter this timeline.
let root = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
let output = URL(fileURLWithPath: CommandLine.arguments[2])
let record = try JSONSerialization.jsonObject(with: Data(contentsOf: root.appendingPathComponent("recording.json"))) as! [String:Any]
precondition(record["success"] as? Bool == true, "Only a successful continuous capture can be rendered")
let quick = record["quick"] as? Bool ?? false
let frames = record["frames"] as! [[String:Any]]
let events = record["events"] as! [[String:Any]]
let duration = record["durationSeconds"] as! Double
precondition(!frames.isEmpty && duration > 0 && (quick || (duration >= 300 && duration <= 600)))
let fps = 5, width = 1440, height = 960
let sampleCount = Int(ceil(duration * Double(fps)))
let rawURL = root.appendingPathComponent("continuous-silent.mov")
try? FileManager.default.removeItem(at: rawURL)
let writer = try AVAssetWriter(outputURL: rawURL, fileType: .mov)
let input = AVAssetWriterInput(mediaType: .video, outputSettings: [AVVideoCodecKey:AVVideoCodecType.h264,AVVideoWidthKey:width,AVVideoHeightKey:height,AVVideoCompressionPropertiesKey:[AVVideoAverageBitRateKey:2_000_000,AVVideoMaxKeyFrameIntervalKey:10]])
input.expectsMediaDataInRealTime = false
let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes:[kCVPixelBufferPixelFormatTypeKey as String:kCVPixelFormatType_32ARGB,kCVPixelBufferWidthKey as String:width,kCVPixelBufferHeightKey as String:height])
writer.add(input);writer.startWriting();writer.startSession(atSourceTime:.zero)
var selected = -1, pointer = 0, selectedCaption = -2
var pixel: CVPixelBuffer?
for sample in 0..<sampleCount {
    let second = Double(sample) / Double(fps)
    while pointer + 1 < frames.count && (frames[pointer + 1]["timeSeconds"] as! Double) <= second { pointer += 1 }
    let captionIndex = events.lastIndex(where: { ($0["startSeconds"] as! Double) <= second }) ?? -1
    if pointer != selected || captionIndex != selectedCaption {
        selected = pointer; selectedCaption = captionIndex
        let nsImage = NSImage(contentsOf: root.appendingPathComponent(frames[pointer]["file"] as! String))!
        var rect = CGRect(x:0,y:0,width:width,height:height)
        let image = nsImage.cgImage(forProposedRect:&rect,context:nil,hints:nil)!
        precondition(image.width > 0 && image.height > 0 && image.width <= width && image.height <= height, "Unexpected capture dimensions")
        var buffer: CVPixelBuffer?
        CVPixelBufferCreate(kCFAllocatorDefault,width,height,kCVPixelFormatType_32ARGB,[kCVPixelBufferCGImageCompatibilityKey:true,kCVPixelBufferCGBitmapContextCompatibilityKey:true] as CFDictionary,&buffer)
        CVPixelBufferLockBaseAddress(buffer!,[])
        let context = CGContext(data:CVPixelBufferGetBaseAddress(buffer!),width:width,height:height,bitsPerComponent:8,bytesPerRow:CVPixelBufferGetBytesPerRow(buffer!),space:CGColorSpaceCreateDeviceRGB(),bitmapInfo:CGImageAlphaInfo.noneSkipFirst.rawValue)!
        context.setFillColor(NSColor.white.cgColor);context.fill(rect)
        context.draw(image,in:CGRect(x:0,y:height-image.height,width:image.width,height:image.height))
        if captionIndex >= 0 {
            context.setFillColor(NSColor(srgbRed:0.078,green:0.243,blue:0.192,alpha:1).cgColor);context.fill(CGRect(x:0,y:0,width:width,height:84))
            NSGraphicsContext.saveGraphicsState();NSGraphicsContext.current=NSGraphicsContext(cgContext:context,flipped:false)
            NSAttributedString(string:events[captionIndex]["title"] as! String,attributes:[.font:NSFont.systemFont(ofSize:21,weight:.semibold),.foregroundColor:NSColor.white]).draw(in:CGRect(x:28,y:42,width:1384,height:29))
            NSAttributedString(string:events[captionIndex]["caption"] as? String ?? "Continuous local source-service demonstration",attributes:[.font:NSFont.systemFont(ofSize:14),.foregroundColor:NSColor.white]).draw(in:CGRect(x:28,y:14,width:1384,height:23))
            NSGraphicsContext.restoreGraphicsState()
        }
        CVPixelBufferUnlockBaseAddress(buffer!,[]);pixel=buffer
    }
    while !input.isReadyForMoreMediaData { Thread.sleep(forTimeInterval:0.01) }
    guard adaptor.append(pixel!,withPresentationTime:CMTime(value:Int64(sample),timescale:Int32(fps))) else { throw writer.error! }
}
let end = CMTime(value:Int64(sampleCount),timescale:Int32(fps))
writer.endSession(atSourceTime:end);input.markAsFinished()
let finished=DispatchSemaphore(value:0);writer.finishWriting { finished.signal() };finished.wait()
if writer.status != .completed { throw writer.error! }
let composition=AVMutableComposition(),video=AVURLAsset(url:rawURL)
let track=composition.addMutableTrack(withMediaType:.video,preferredTrackID:kCMPersistentTrackID_Invalid)!
try track.insertTimeRange(CMTimeRange(start:.zero,duration:end),of:video.tracks(withMediaType:.video)[0],at:.zero)
if !quick {
    let narration=composition.addMutableTrack(withMediaType:.audio,preferredTrackID:kCMPersistentTrackID_Invalid)!
    for (index,event) in events.enumerated() {
        let audio=AVURLAsset(url:root.appendingPathComponent(String(format:"audio/%02d.aiff",index)))
        let start=event["startSeconds"] as! Double, finish=event["endSeconds"] as! Double
        precondition(CMTimeGetSeconds(audio.duration) <= finish-start, "Narration exceeds its original scene time")
        try narration.insertTimeRange(CMTimeRange(start:.zero,duration:audio.duration),of:audio.tracks(withMediaType:.audio)[0],at:CMTime(seconds:start,preferredTimescale:600))
    }
}
try? FileManager.default.removeItem(at:output)
let exporter=AVAssetExportSession(asset:composition,presetName:AVAssetExportPresetHighestQuality)!
exporter.outputURL=output;exporter.outputFileType = .mp4;exporter.shouldOptimizeForNetworkUse=true
let done=DispatchSemaphore(value:0);exporter.exportAsynchronously { done.signal() };done.wait()
if exporter.status != .completed { throw exporter.error! }
let result=AVURLAsset(url:output),generator=AVAssetImageGenerator(asset:AVURLAsset(url:output));generator.appliesPreferredTrackTransform=true
for (index,second) in [0.0,duration*0.25,duration*0.5,duration*0.75,max(0,duration-1)].enumerated() {
    let image=try generator.copyCGImage(at:CMTime(seconds:second,preferredTimescale:600),actualTime:nil)
    try NSBitmapImageRep(cgImage:image).representation(using:.png,properties:[:])!.write(to:root.appendingPathComponent("verify-\(index).png"))
}
let attributes=try FileManager.default.attributesOfItem(atPath:output.path)
let report:[String:Any]=["command":"swift scripts/render-continuous.swift \(CommandLine.arguments[1]) \(CommandLine.arguments[2])","success":true,"quick":quick,"format":"Continuous CDP capture, five fps, H.264/AAC; no cuts or scene retiming","durationSeconds":CMTimeGetSeconds(result.duration),"captureDurationSeconds":duration,"rawFrames":frames.count,"encodedFrames":sampleCount,"videoTracks":result.tracks(withMediaType:.video).count,"audioTracks":result.tracks(withMediaType:.audio).count,"bytes":attributes[.size]!]
let data=try JSONSerialization.data(withJSONObject:report,options:.prettyPrinted)
try data.write(to:root.appendingPathComponent("video-verification.json"));print(String(data:data,encoding:.utf8)!)
