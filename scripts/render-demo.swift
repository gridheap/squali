import Foundation
import AppKit
import AVFoundation
import CoreVideo

let root = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
let output = URL(fileURLWithPath: CommandLine.arguments[2])
let frames = try JSONSerialization.jsonObject(with: Data(contentsOf: root.appendingPathComponent("frames.json"))) as! [[String:Any]]
let scenes = try JSONSerialization.jsonObject(with: Data(contentsOf: root.appendingPathComponent("timeline.json"))) as! [[String:Any]]
let duration = scenes.reduce(0) { $0 + ($1["duration"] as! Int) }
let rawURL = root.appendingPathComponent("silent.mov")
try? FileManager.default.removeItem(at: rawURL)
let writer = try AVAssetWriter(outputURL: rawURL, fileType: .mov)
let width = 1440, height = 900
let input = AVAssetWriterInput(mediaType: .video, outputSettings: [AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: width, AVVideoHeightKey: height, AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: 1_800_000, AVVideoMaxKeyFrameIntervalKey: 30]])
input.expectsMediaDataInRealTime = false
let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32ARGB, kCVPixelBufferWidthKey as String: width, kCVPixelBufferHeightKey as String: height])
writer.add(input); writer.startWriting(); writer.startSession(atSourceTime: .zero)
var currentFrame = -1
var pixel: CVPixelBuffer?
for second in 0..<duration {
    let index = frames.lastIndex(where: { ($0["time"] as! Int) <= second }) ?? 0
    if index != currentFrame {
        currentFrame = index
        let url = root.appendingPathComponent(frames[index]["file"] as! String)
        let nsImage = NSImage(contentsOf: url)!
        var rect = CGRect(x: 0, y: 0, width: width, height: height)
        let image = nsImage.cgImage(forProposedRect: &rect, context: nil, hints: nil)!
        var buffer: CVPixelBuffer?
        CVPixelBufferCreate(kCFAllocatorDefault, width, height, kCVPixelFormatType_32ARGB, [kCVPixelBufferCGImageCompatibilityKey:true,kCVPixelBufferCGBitmapContextCompatibilityKey:true] as CFDictionary, &buffer)
        CVPixelBufferLockBaseAddress(buffer!, [])
        let context = CGContext(data: CVPixelBufferGetBaseAddress(buffer!), width: width, height: height, bitsPerComponent: 8, bytesPerRow: CVPixelBufferGetBytesPerRow(buffer!), space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue)!
        context.draw(image, in: rect)
        CVPixelBufferUnlockBaseAddress(buffer!, [])
        pixel = buffer
    }
    while !input.isReadyForMoreMediaData { Thread.sleep(forTimeInterval: 0.01) }
    guard adaptor.append(pixel!, withPresentationTime: CMTime(value: Int64(second), timescale: 1)) else { throw writer.error! }
}
writer.endSession(atSourceTime: CMTime(value: Int64(duration), timescale: 1));input.markAsFinished()
let finish = DispatchSemaphore(value: 0);writer.finishWriting { finish.signal() };finish.wait()
if writer.status != .completed { throw writer.error! }
let composition = AVMutableComposition()
let video = AVURLAsset(url: rawURL)
let videoTrack = composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid)!
try videoTrack.insertTimeRange(CMTimeRange(start: .zero, duration: CMTime(value: Int64(duration), timescale: 1)), of: video.tracks(withMediaType: .video)[0], at: .zero)
let audioTrack = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid)!
for (index, scene) in scenes.enumerated() {
    let audio = AVURLAsset(url: root.appendingPathComponent(String(format:"audio/%02d.aiff",index)))
    let start = CMTime(value: Int64(scene["start"] as! Int), timescale: 1)
    try audioTrack.insertTimeRange(CMTimeRange(start: .zero, duration: audio.duration), of: audio.tracks(withMediaType: .audio)[0], at: start)
}
try? FileManager.default.removeItem(at: output)
let exporter = AVAssetExportSession(asset: composition, presetName: AVAssetExportPresetHighestQuality)!
exporter.outputURL = output;exporter.outputFileType = .mp4;exporter.shouldOptimizeForNetworkUse = true
let done = DispatchSemaphore(value: 0);exporter.exportAsynchronously { done.signal() };done.wait()
if exporter.status != .completed { throw exporter.error! }
let result = AVURLAsset(url: output)
print("Created \(output.lastPathComponent): \(CMTimeGetSeconds(result.duration)) seconds, \(result.tracks(withMediaType: .video).count) video and \(result.tracks(withMediaType: .audio).count) audio tracks")
