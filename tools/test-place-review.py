"""Regressions for access precedence and the public category cap."""
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('review', Path(__file__).with_name('review-place-catalog.py'))
review = importlib.util.module_from_spec(spec)
spec.loader.exec_module(review)


def row(facts=None, tags=None, category='attraction'):
    result = {'category': category, 'facts': facts or {}}
    if tags is not None: result['accessTags'] = {'matched': True, 'tags': tags}
    return result


class ReviewTests(unittest.TestCase):
    def test_display_cap_includes_fuel(self):
        self.assertEqual(len(review.CATEGORIES), 10)
        self.assertIn('fuel_station', review.CATEGORIES)

    def test_access_yes_is_not_car_permission(self):
        self.assertEqual(review.car_access(row(tags={'access':'yes'}))['status'], 'unknown')

    def test_specific_permission_overrides_generic_restriction(self):
        result = review.car_access(row(tags={'access':'no','motorcar':'yes'}))
        self.assertEqual(result['status'], 'allowed_by_tag')
        self.assertFalse(result['routeVerified'])

    def test_specific_restriction_overrides_generic_permission(self):
        self.assertEqual(review.car_access(row(tags={'access':'yes','motor_vehicle':'no'}))['status'], 'restricted_by_tag')

    def test_conditional_permission_needs_review(self):
        self.assertEqual(review.car_access(row(tags={'motorcar':'yes','access:conditional':'no @ (Mo-Fr)'}))['status'], 'unknown')

    def test_parking_and_fuel_do_not_imply_access(self):
        for category in ('parking','charging_station','fuel_station'):
            self.assertEqual(review.car_access(row(category=category,tags={}))['status'], 'unknown')

    def test_peak_is_not_drive_destination(self):
        r = row({'natural':'peak'}, tags={})
        self.assertEqual(review.display_category(r), 'nature')
        self.assertEqual(review.car_access(r)['reason'], 'terrain_poi_requires_separate_vehicle_entrance')

    def test_legacy_generic_restriction_is_not_complete_vehicle_evidence(self):
        self.assertEqual(review.car_access(row({'access':'no'}))['status'], 'unknown')

    def test_display_precedence(self):
        self.assertEqual(review.display_category(row({'amenity':'place_of_worship','historic':'temple'})), 'religion')
        self.assertEqual(review.display_category(row({'tourism':'museum'})), 'culture')
        self.assertEqual(review.display_category(row({'natural':'beach'})), 'waterfront')


if __name__ == '__main__': unittest.main()
