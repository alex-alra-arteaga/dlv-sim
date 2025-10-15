#!/usr/bin/env python3
import json
import statistics

def load_jsonl(filename):
    """Load JSONL file and return list of JSON objects"""
    results = []
    with open(filename, 'r') as f:
        for line in f:
            if line.strip():
                results.append(json.loads(line.strip()))
    return results

def analyze_results(results):
    """Extract APY metrics from results"""
    successful_results = [r for r in results if r['ok']]
    
    vault_apys = [r['apy']['vault'] for r in successful_results]
    hold_apys = [r['apy']['hold'] for r in successful_results]
    diff_apys = [r['apy']['diff'] for r in successful_results]
    
    return {
        'count': len(successful_results),
        'vault_apy': {
            'mean': statistics.mean(vault_apys),
            'median': statistics.median(vault_apys),
            'min': min(vault_apys),
            'max': max(vault_apys),
            'stddev': statistics.stdev(vault_apys) if len(vault_apys) > 1 else 0
        },
        'hold_apy': {
            'mean': statistics.mean(hold_apys),
            'median': statistics.median(hold_apys),
            'min': min(hold_apys),
            'max': max(hold_apys),
            'stddev': statistics.stdev(hold_apys) if len(hold_apys) > 1 else 0
        },
        'diff_apy': {
            'mean': statistics.mean(diff_apys),
            'median': statistics.median(diff_apys),
            'min': min(diff_apys),
            'max': max(diff_apys),
            'stddev': statistics.stdev(diff_apys) if len(diff_apys) > 1 else 0
        }
    }

def compare_same_combinations(disabled_results, enabled_results):
    """Compare APY changes for the same parameter combinations"""
    # Create dictionaries keyed by combination key
    disabled_dict = {r['key']: r for r in disabled_results if r['ok']}
    enabled_dict = {r['key']: r for r in enabled_results if r['ok']}
    
    # Find common keys
    common_keys = set(disabled_dict.keys()) & set(enabled_dict.keys())
    
    comparisons = []
    for key in common_keys:
        disabled = disabled_dict[key]
        enabled = enabled_dict[key]
        
        vault_change = enabled['apy']['vault'] - disabled['apy']['vault']
        hold_change = enabled['apy']['hold'] - disabled['apy']['hold']
        diff_change = enabled['apy']['diff'] - disabled['apy']['diff']
        
        comparisons.append({
            'key': key,
            'charm': disabled['charm'],
            'dlv': disabled['dlv'],
            'disabled_apy': disabled['apy'],
            'enabled_apy': enabled['apy'],
            'vault_change': vault_change,
            'hold_change': hold_change,
            'diff_change': diff_change,
            'abs_vault_change': abs(vault_change),
            'abs_diff_change': abs(diff_change)
        })
    
    return comparisons

def main():
    print("Loading results...")
    disabled_results = load_jsonl('brute-force-results_ai_disabled.jsonl')
    enabled_results = load_jsonl('brute-force-results_ai_enabled_subset.jsonl')
    
    print(f"AI Disabled: {len(disabled_results)} total results")
    print(f"AI Enabled: {len(enabled_results)} total results")
    
    # Analyze overall performance
    print("\n" + "="*60)
    print("OVERALL PERFORMANCE ANALYSIS")
    print("="*60)
    
    disabled_stats = analyze_results(disabled_results)
    enabled_stats = analyze_results(enabled_results)
    
    print(f"\nAI DISABLED ({disabled_stats['count']} successful runs):")
    print(f"  Vault APY: {disabled_stats['vault_apy']['mean']:.2f}% ± {disabled_stats['vault_apy']['stddev']:.2f}%")
    print(f"  Hold APY:  {disabled_stats['hold_apy']['mean']:.2f}% ± {disabled_stats['hold_apy']['stddev']:.2f}%")
    print(f"  Diff APY:  {disabled_stats['diff_apy']['mean']:.2f}% ± {disabled_stats['diff_apy']['stddev']:.2f}%")
    
    print(f"\nAI ENABLED ({enabled_stats['count']} successful runs):")
    print(f"  Vault APY: {enabled_stats['vault_apy']['mean']:.2f}% ± {enabled_stats['vault_apy']['stddev']:.2f}%")
    print(f"  Hold APY:  {enabled_stats['hold_apy']['mean']:.2f}% ± {enabled_stats['hold_apy']['stddev']:.2f}%")
    print(f"  Diff APY:  {enabled_stats['diff_apy']['mean']:.2f}% ± {enabled_stats['diff_apy']['stddev']:.2f}%")
    
    # Calculate improvements
    vault_improvement = enabled_stats['vault_apy']['mean'] - disabled_stats['vault_apy']['mean']
    diff_improvement = enabled_stats['diff_apy']['mean'] - disabled_stats['diff_apy']['mean']
    
    print(f"\nIMPROVEMENT WITH AI NEURAL AGENT:")
    print(f"  Vault APY: {vault_improvement:+.2f}% ({vault_improvement/disabled_stats['vault_apy']['mean']*100:+.1f}%)")
    print(f"  Diff APY:  {diff_improvement:+.2f}% ({'Infinite' if disabled_stats['diff_apy']['mean'] == 0 else f'{diff_improvement/abs(disabled_stats["diff_apy"]["mean"])*100:+.1f}%'})")
    
    # Compare same combinations
    print("\n" + "="*60)
    print("SAME COMBINATION COMPARISONS")
    print("="*60)
    
    comparisons = compare_same_combinations(disabled_results, enabled_results)
    print(f"\nFound {len(comparisons)} matching combinations")
    
    if comparisons:
        # Sort by biggest vault APY improvements
        comparisons.sort(key=lambda x: x['vault_change'], reverse=True)
        
        print(f"\nTOP 10 BIGGEST VAULT APY IMPROVEMENTS:")
        print("-" * 80)
        for i, comp in enumerate(comparisons[:10]):
            print(f"{i+1:2d}. Key: {comp['key']}")
            print(f"    Vault APY: {comp['disabled_apy']['vault']:.2f}% → {comp['enabled_apy']['vault']:.2f}% ({comp['vault_change']:+.2f}%)")
            print(f"    Diff APY:  {comp['disabled_apy']['diff']:.2f}% → {comp['enabled_apy']['diff']:.2f}% ({comp['diff_change']:+.2f}%)")
            print(f"    Config: wideThreshold={comp['charm']['wideThreshold']}, baseThreshold={comp['charm']['baseThreshold']}")
            print(f"            devAbove={comp['dlv']['deviationThresholdAbove']}, devBelow={comp['dlv']['deviationThresholdBelow']}")
            print()
        
        # Sort by biggest absolute vault APY changes
        comparisons.sort(key=lambda x: x['abs_vault_change'], reverse=True)
        
        print(f"\nTOP 10 BIGGEST ABSOLUTE VAULT APY CHANGES:")
        print("-" * 80)
        for i, comp in enumerate(comparisons[:10]):
            print(f"{i+1:2d}. Key: {comp['key']}")
            print(f"    Vault APY: {comp['disabled_apy']['vault']:.2f}% → {comp['enabled_apy']['vault']:.2f}% ({comp['vault_change']:+.2f}%)")
            print(f"    Diff APY:  {comp['disabled_apy']['diff']:.2f}% → {comp['enabled_apy']['diff']:.2f}% ({comp['diff_change']:+.2f}%)")
            print(f"    Config: wideThreshold={comp['charm']['wideThreshold']}, baseThreshold={comp['charm']['baseThreshold']}")
            print(f"            devAbove={comp['dlv']['deviationThresholdAbove']}, devBelow={comp['dlv']['deviationThresholdBelow']}")
            print()
        
        # Summary statistics of changes
        vault_changes = [c['vault_change'] for c in comparisons]
        diff_changes = [c['diff_change'] for c in comparisons]
        
        print(f"\nCHANGE STATISTICS (across {len(comparisons)} matching combinations):")
        print(f"  Vault APY Change: {statistics.mean(vault_changes):.2f}% ± {statistics.stdev(vault_changes):.2f}%")
        print(f"  Diff APY Change:  {statistics.mean(diff_changes):.2f}% ± {statistics.stdev(diff_changes):.2f}%")
        print(f"  Positive vault changes: {sum(1 for c in vault_changes if c > 0)}/{len(vault_changes)} ({sum(1 for c in vault_changes if c > 0)/len(vault_changes)*100:.1f}%)")
        print(f"  Positive diff changes:  {sum(1 for c in diff_changes if c > 0)}/{len(diff_changes)} ({sum(1 for c in diff_changes if c > 0)/len(diff_changes)*100:.1f}%)")

if __name__ == "__main__":
    main()