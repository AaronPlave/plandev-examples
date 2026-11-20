@MissionModel(model = Mission.class)
@WithMappers(BasicValueMappers.class)
@WithConfiguration(Configuration.class)
@WithSubsystem("flight")
@WithSubsystem("payload")

@WithActivityType(PerformHop.class)
@WithActivityType(AcquireSurveyImages.class)

package moonfall;

import moonfall.activities.PerformHop;
import moonfall.activities.AcquireSurveyImages;
import gov.nasa.ammos.plandev.contrib.serialization.rulesets.BasicValueMappers;
import gov.nasa.ammos.plandev.merlin.framework.annotations.MissionModel;
import gov.nasa.ammos.plandev.merlin.framework.annotations.MissionModel.WithActivityType;
import gov.nasa.ammos.plandev.merlin.framework.annotations.MissionModel.WithConfiguration;
import gov.nasa.ammos.plandev.merlin.framework.annotations.MissionModel.WithMappers;
import gov.nasa.ammos.plandev.merlin.framework.annotations.MissionModel.WithSubsystem;
