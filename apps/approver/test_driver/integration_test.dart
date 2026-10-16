import 'dart:io';

import 'package:integration_test/integration_test_driver_extended.dart';

Future<void> main() async {
  final directory = Platform.environment['SPENDWALL_EVIDENCE_DIR'];
  if (directory == null || !Directory(directory).isAbsolute) {
    throw StateError(
      'Set SPENDWALL_EVIDENCE_DIR to an absolute evidence directory.',
    );
  }
  await Directory(directory).create(recursive: true);
  await integrationDriver(
    onScreenshot: (name, bytes, [args]) async {
      if (!RegExp(r'^[a-z0-9-]+$').hasMatch(name)) return false;
      await File('$directory/$name.png').writeAsBytes(bytes);
      return true;
    },
  );
}
