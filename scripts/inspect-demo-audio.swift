import Foundation
import AVFoundation
import Accelerate

// E2E media acceptance: decode the final movie, rather than trusting its track
// count. Fail on a missing track, failed decoding, silence or missing narration
// in any scene. This checks signal presence, not speech-recognition accuracy.
let root = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
let movie = URL(fileURLWithPath: CommandLine.arguments[2])
let record = try JSONSerialization.jsonObject(with: Data(contentsOf: root.appendingPathComponent("recording.json"))) as! [String: Any]
let events = record["events"] as! [[String: Any]]
let asset = AVURLAsset(url: movie)
let tracks = asset.tracks(withMediaType: .audio)
precondition(tracks.count == 1, "The final demonstration must contain one narration track")
let reader = try AVAssetReader(asset: asset)
let output = AVAssetReaderTrackOutput(track: tracks[0], outputSettings: [
    AVFormatIDKey: kAudioFormatLinearPCM,
    AVLinearPCMBitDepthKey: 32,
    AVLinearPCMIsFloatKey: true,
    AVLinearPCMIsBigEndianKey: false,
    AVLinearPCMIsNonInterleaved: false
])
reader.add(output)
precondition(reader.startReading(), "Start audio decoding")
var peak: Float = 0
var decodedSeconds = 0.0
var audibleSeconds = Array(repeating: 0.0, count: events.count)
var sumSquares = 0.0
var samples = 0
while let sample = output.copyNextSampleBuffer() {
    guard let block = CMSampleBufferGetDataBuffer(sample) else { fatalError("Audio sample has no data") }
    let bytes = CMBlockBufferGetDataLength(block)
    precondition(bytes % MemoryLayout<Float>.size == 0)
    let count = bytes / MemoryLayout<Float>.size
    let values = UnsafeMutablePointer<Float>.allocate(capacity: count)
    defer { values.deallocate() }
    precondition(CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: bytes, destination: values) == kCMBlockBufferNoErr)
    var maximum: Float = 0, power: Float = 0
    vDSP_maxmgv(values, 1, &maximum, vDSP_Length(count))
    vDSP_svesq(values, 1, &power, vDSP_Length(count))
    precondition(maximum.isFinite && power.isFinite, "Audio contains invalid samples")
    peak = max(peak, maximum);sumSquares += Double(power);samples += count
    let start = CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sample))
    let duration = CMTimeGetSeconds(CMSampleBufferGetDuration(sample))
    precondition(start.isFinite && duration.isFinite && duration > 0)
    decodedSeconds += duration
    if sqrt(Double(power) / Double(max(1, count))) > 0.0001 {
        for (index, event) in events.enumerated() {
            let a = event["startSeconds"] as! Double, b = event["endSeconds"] as! Double
            audibleSeconds[index] += max(0, min(start + duration, b) - max(start, a))
        }
    }
}
precondition(reader.status == .completed, "Final audio decoding must finish")
precondition(peak > 0.05 && peak <= 1.001 && samples > 0, "Narration signal is missing or invalid")
precondition(events.count == 8 && audibleSeconds.allSatisfy { $0 > 10 }, "Every scene must contain audible narration")
let report: [String: Any] = [
    "command": "swift scripts/inspect-demo-audio.swift \(CommandLine.arguments[1]) \(CommandLine.arguments[2])",
    "success": true,
    "decodedSeconds": decodedSeconds,
    "decodedSamples": samples,
    "peakAmplitude": peak,
    "rmsAmplitude": sqrt(sumSquares / Double(samples)),
    "sceneAudibleSeconds": audibleSeconds,
    "scope": "Decoded PCM signal in all eight scenes; narration is the retained script rendered by the installed Samantha voice. This is not speech recognition."
]
let data = try JSONSerialization.data(withJSONObject: report, options: .prettyPrinted)
try data.write(to: root.appendingPathComponent("audio-verification.json"))
print(String(data: data, encoding: .utf8)!)
