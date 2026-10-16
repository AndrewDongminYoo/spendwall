import 'dart:async';

import 'package:flutter/material.dart';

import 'controller.dart';
import 'model.dart';

class ApproverApp extends StatefulWidget {
  const ApproverApp({super.key, required this.controller, this.setupMessage});
  final ApproverController controller;
  final String? setupMessage;
  @override
  State<ApproverApp> createState() => _ApproverAppState();
}

class _ApproverAppState extends State<ApproverApp> with WidgetsBindingObserver {
  final _endpoint = TextEditingController();
  final _device = TextEditingController();
  final _credential = TextEditingController();
  Timer? _timer;
  bool _paused = false;
  ApproverController get c => widget.controller;
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _timer = Timer.periodic(const Duration(seconds: 1), (_) => c.tick());
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // Native biometric dialogs may cause inactive; only actual backgrounding cancels.
    if (state == AppLifecycleState.paused ||
        state == AppLifecycleState.detached) {
      _paused = true;
      c.pause();
    } else if (state == AppLifecycleState.resumed && _paused) {
      _paused = false;
      unawaited(c.resume());
    }
  }

  @override
  void dispose() {
    _timer?.cancel();
    WidgetsBinding.instance.removeObserver(this);
    _endpoint.dispose();
    _device.dispose();
    _credential.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => MaterialApp(
    title: 'Spendwall',
    debugShowCheckedModeBanner: false,
    theme: ThemeData(
      brightness: Brightness.dark,
      useMaterial3: true,
      colorScheme: ColorScheme.fromSeed(
        seedColor: const Color(0xff7cd8c0),
        brightness: Brightness.dark,
        surface: const Color(0xff121c23),
      ),
      scaffoldBackgroundColor: const Color(0xff0c141b),
      inputDecorationTheme: const InputDecorationTheme(
        border: OutlineInputBorder(),
      ),
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(minimumSize: const Size(48, 52)),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(minimumSize: const Size(48, 52)),
      ),
    ),
    home: ListenableBuilder(
      listenable: c,
      builder: (context, _) => Scaffold(
        appBar: AppBar(
          leading: c.selected == null
              ? null
              : IconButton(
                  tooltip: 'Back to requests',
                  onPressed: c.working ? null : c.back,
                  icon: const Icon(Icons.arrow_back),
                ),
          title: const Text('Spendwall'),
          actions: c.connected
              ? [
                  IconButton(
                    tooltip: 'Refresh',
                    onPressed: c.working ? null : c.refresh,
                    icon: const Icon(Icons.refresh),
                  ),
                  IconButton(
                    tooltip: 'Disconnect device',
                    onPressed: c.working ? null : c.disconnect,
                    icon: const Icon(Icons.logout),
                  ),
                ]
              : null,
        ),
        body: SafeArea(
          child: Center(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 640),
              child: Column(
                children: [
                  if (c.working) const LinearProgressIndicator(),
                  if (c.message != null)
                    Container(
                      width: double.infinity,
                      padding: const EdgeInsets.all(16),
                      color: Theme.of(context).colorScheme.surfaceContainerHigh,
                      child: Text(
                        c.message!,
                        key: const Key('status-message'),
                        semanticsLabel: c.message,
                      ),
                    ),
                  Expanded(
                    child: SingleChildScrollView(
                      padding: const EdgeInsets.fromLTRB(24, 20, 24, 32),
                      child: c.connected
                          ? (c.selected == null
                                ? _queue(context)
                                : _detail(context, c.selected!))
                          : _enroll(context),
                    ),
                  ),
                  if (c.selected != null) _actions(context),
                ],
              ),
            ),
          ),
        ),
      ),
    ),
  );
  Widget _heading(BuildContext context, String text) => Padding(
    padding: const EdgeInsets.only(top: 24, bottom: 12),
    child: Text(text, style: Theme.of(context).textTheme.titleMedium),
  );
  Widget _fact(String label, String value) => Padding(
    padding: const EdgeInsets.only(bottom: 16),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          label,
          style: const TextStyle(color: Color(0xffa9b9c4), fontSize: 12),
        ),
        const SizedBox(height: 4),
        SelectableText(value),
      ],
    ),
  );
  Widget _enroll(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      const Icon(
        Icons.verified_user_outlined,
        size: 48,
        color: Color(0xff7cd8c0),
      ),
      const SizedBox(height: 24),
      Text(
        'Connect your device',
        style: Theme.of(context).textTheme.headlineMedium,
      ),
      const SizedBox(height: 12),
      const Text(
        'Review payment requests with the original facts. Every decision requires your biometrics.',
      ),
      if (widget.setupMessage != null)
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 20),
          child: Text(widget.setupMessage!),
        ),
      const SizedBox(height: 24),
      TextField(
        controller: _endpoint,
        enabled: !c.working,
        keyboardType: TextInputType.url,
        autocorrect: false,
        decoration: const InputDecoration(
          labelText: 'Approval service',
          hintText: 'https://approvals.example',
        ),
      ),
      const SizedBox(height: 16),
      TextField(
        controller: _device,
        enabled: !c.working,
        autocorrect: false,
        decoration: const InputDecoration(labelText: 'Provisioned device ID'),
      ),
      const SizedBox(height: 16),
      TextField(
        key: const Key('credential'),
        controller: _credential,
        enabled: !c.working,
        obscureText: true,
        autocorrect: false,
        enableSuggestions: false,
        decoration: const InputDecoration(
          labelText: 'One-use enrollment credential',
        ),
      ),
      const SizedBox(height: 24),
      FilledButton(
        onPressed: c.working || widget.setupMessage != null
            ? null
            : () async {
                final credential = _credential.text;
                _credential.clear();
                FocusManager.instance.primaryFocus?.unfocus();
                await c.enroll(
                  _endpoint.text.trim(),
                  _device.text.trim(),
                  credential,
                );
              },
        child: const Text('Connect securely'),
      ),
      const SizedBox(height: 16),
      const Text(
        'Your session lasts up to 15 minutes. Ask your administrator for a new credential after it expires.',
      ),
    ],
  );
  Widget _queue(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      Text(
        'Requests to review',
        style: Theme.of(context).textTheme.headlineMedium,
      ),
      const SizedBox(height: 8),
      const Text('Open a request to verify its facts before deciding.'),
      const SizedBox(height: 24),
      if (c.items.isEmpty)
        const Padding(
          padding: EdgeInsets.symmetric(vertical: 48),
          child: Column(
            children: [
              Icon(Icons.task_alt, size: 48),
              SizedBox(height: 16),
              Text('No pending requests'),
              SizedBox(height: 8),
              Text('Refresh to check for new requests.'),
            ],
          ),
        ),
      for (final item in c.items)
        Card(
          margin: const EdgeInsets.only(bottom: 12),
          child: InkWell(
            onTap: c.working ? null : () => c.open(item.id),
            borderRadius: BorderRadius.circular(12),
            child: Padding(
              padding: const EdgeInsets.all(20),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    'USD ${item.amount}',
                    style: Theme.of(context).textTheme.headlineSmall,
                  ),
                  const SizedBox(height: 8),
                  Text(item.customerId),
                  const SizedBox(height: 8),
                  Text(
                    item.actionableAt(c.clock())
                        ? 'Awaiting your review →'
                        : _state(item),
                  ),
                ],
              ),
            ),
          ),
        ),
      if (c.nextCursor != null)
        OutlinedButton(
          onPressed: c.working ? null : () => c.refresh(more: true),
          child: const Text('Load more'),
        ),
    ],
  );
  String _state(Approval a) {
    if (c.uncertain) return 'Outcome unconfirmed';
    if (a.status == 'denied') return 'Request denied';
    if (a.status == 'expired' ||
        (a.status == 'pending' && !a.actionableAt(c.clock()))) {
      return 'Expired';
    }
    return switch (a.executionState) {
      'succeeded' => 'Refund completed',
      'failed' => 'Refund failed',
      'unknown' => 'Execution unknown',
      'in_flight' => 'Refund in progress',
      _ => 'Review required',
    };
  }

  Widget _detail(BuildContext context, Approval a) => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      Text(
        _state(a),
        style: const TextStyle(
          color: Color(0xff7cd8c0),
          fontWeight: FontWeight.w600,
        ),
      ),
      const SizedBox(height: 16),
      const Text(
        'REFUND REQUEST',
        style: TextStyle(
          letterSpacing: 1.6,
          color: Color(0xffa9b9c4),
          fontSize: 12,
        ),
      ),
      const SizedBox(height: 8),
      Text(
        'USD ${a.amount}',
        style: Theme.of(context).textTheme.displaySmall
            ?.copyWith(fontWeight: FontWeight.w600),
      ),
      const SizedBox(height: 24),
      _fact('Customer', a.customerId),
      _fact('Agent', a.agentId),
      if (a.executionState == 'unknown' ||
          a.executionState == 'failed' ||
          a.executionState == 'in_flight' ||
          c.uncertain)
        const Padding(
          padding: EdgeInsets.only(bottom: 16),
          child: Text(
            'Do not retry this refund. Refresh for the server result or ask your administrator to reconcile it.',
          ),
        ),
      _fact('Expires', '${a.expiresAt.toLocal()}'),
      _heading(context, 'Original request'),
      _fact('Merchant', a.merchantId),
      _fact('Capture', a.captureId),
      _fact('Arguments', a.arguments),
      _fact('Argument hash', a.argsHash),
      _heading(context, 'Policy evidence'),
      for (final rule in a.rules) _fact('Matched rule', rule),
      _fact('Policy version', a.policyVersion),
      _fact('Approval ID', a.id),
      if (a.executionId != null) _fact('Execution ID', a.executionId!),
      if (a.refundId != null) _fact('Refund ID', a.refundId!),
      _heading(context, 'AI reference'),
      const Text(
        'AI-generated reference only; not authorization',
        style: TextStyle(color: Color(0xffd6bb85)),
      ),
      const SizedBox(height: 12),
      if (c.summary != null)
        ...c.summary!.map(
          (s) => Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: Text(s),
          ),
        ),
      TextButton(
        onPressed: c.summarizing ? null : c.requestSummary,
        child: Text(
          c.summarizing ? 'Loading reference…' : 'Load optional reference',
        ),
      ),
    ],
  );
  Widget _actions(BuildContext context) => Container(
    padding: const EdgeInsets.fromLTRB(24, 12, 24, 16),
    decoration: BoxDecoration(
      color: Theme.of(context).colorScheme.surface,
      border: const Border(top: BorderSide(color: Color(0xff30434e))),
    ),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (!c.biometricAvailable)
          const Padding(
            padding: EdgeInsets.only(bottom: 8),
            child: Text('Biometrics are unavailable. Decisions are disabled.'),
          ),
        FilledButton(
          onPressed: c.canDecide ? () => c.decide('approve') : null,
          child: const Text('Approve refund'),
        ),
        const SizedBox(height: 8),
        OutlinedButton(
          onPressed: c.canDecide ? () => c.decide('deny') : null,
          child: const Text('Deny request'),
        ),
      ],
    ),
  );
}
